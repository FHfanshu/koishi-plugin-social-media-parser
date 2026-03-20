import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

import type { Logger } from 'koishi'

import type { CompressedBinary, ProcessedVideoForContext } from '../types'
import type { MediaInjectConfig } from '../config'
import { extensionFromMime } from './http'

const BINARY_ACCESS = fsConstants.X_OK
const execFileAsync = promisify(execFile)

export async function compressImageForContext(
  input: Buffer,
  mimeType: string,
  config: MediaInjectConfig,
  logger: Logger
): Promise<CompressedBinary | null> {
  const ffmpeg = await resolveFfmpegBinary()
  if (!ffmpeg) {
    return {
      buffer: input,
      mimeType,
      ext: extensionFromMime(mimeType),
    }
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'social-media-image-'))
  const inputPath = path.join(tempDir, `input${extensionFromMime(mimeType)}`)
  const outputPath = path.join(tempDir, 'output.jpg')

  try {
    await writeFile(inputPath, input)

    const quality = mapImageQualityToQscale(config.imageQuality)
    const edge = Math.max(256, Math.floor(config.imageMaxEdgePx))

    await runCommand(
      ffmpeg,
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`,
        '-q:v',
        String(quality),
        outputPath,
      ],
      config.ffmpegTimeoutMs
    )

    const buffer = await readFile(outputPath)
    if (!buffer.length) {
      return {
        buffer: input,
        mimeType,
        ext: extensionFromMime(mimeType),
      }
    }

    return {
      buffer,
      mimeType: 'image/jpeg',
      ext: '.jpg',
    }
  } catch (error) {
    logger.info(`image compress fallback: ${String((error as Error)?.message || error)}`)
    return {
      buffer: input,
      mimeType,
      ext: extensionFromMime(mimeType),
    }
  } finally {
    await safeCleanup(tempDir)
  }
}

export async function processVideoForContext(
  input: Buffer,
  mimeType: string,
  config: MediaInjectConfig,
  logger: Logger
): Promise<ProcessedVideoForContext | null> {
  const ffmpeg = await resolveFfmpegBinary()
  const ffprobe = await resolveFfprobeBinary()
  if (!ffmpeg || !ffprobe) {
    return null
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'social-media-video-'))
  const inputPath = path.join(tempDir, `input${extensionFromMime(mimeType)}`)

  try {
    await writeFile(inputPath, input)

    const durationSec = await readVideoDuration(ffprobe, inputPath, config.ffmpegTimeoutMs)
    if (durationSec == null) {
      logger.info('video duration probe failed, skip video processing')
      return null
    }

    const isLongVideo = durationSec > config.videoMaxDurationSec

    if (!isLongVideo) {
      const short = await compressShortVideo(ffmpeg, inputPath, durationSec, config, tempDir)
      if (!short) {
        return null
      }

      return {
        mode: 'short-video',
        durationSec,
        video: short,
        frames: [],
      }
    }

    const frames = await extractVideoFrames(ffmpeg, inputPath, config, tempDir)
    const audio = config.keepAudio ? await extractVideoAudio(ffmpeg, inputPath, config, tempDir, logger) : undefined

    return {
      mode: 'long-video',
      durationSec,
      frames,
      audio,
    }
  } finally {
    await safeCleanup(tempDir)
  }
}

async function compressShortVideo(
  ffmpeg: string,
  inputPath: string,
  durationSec: number,
  config: MediaInjectConfig,
  tempDir: string
): Promise<CompressedBinary | null> {
  const outputPath = path.join(tempDir, 'short.mp4')
  const targetDuration = Math.max(1, Math.min(durationSec || config.videoMaxDurationSec, config.videoMaxDurationSec))
  const resolution = Math.max(240, Math.floor(config.videoResolution))

  try {
    await runCommand(
      ffmpeg,
      [
        '-y',
        '-i',
        inputPath,
        '-t',
        String(targetDuration),
        '-vf',
        `scale=-2:${resolution}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-c:a',
        'copy',
        outputPath,
      ],
      config.ffmpegTimeoutMs
    )
  } catch {
    await runCommand(
      ffmpeg,
      [
        '-y',
        '-i',
        inputPath,
        '-t',
        String(targetDuration),
        '-vf',
        `scale=-2:${resolution}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        outputPath,
      ],
      config.ffmpegTimeoutMs
    )
  }

  const buffer = await readFile(outputPath)
  if (!buffer.length) {
    return null
  }

  return {
    buffer,
    mimeType: 'video/mp4',
    ext: '.mp4',
  }
}

async function extractVideoFrames(
  ffmpeg: string,
  inputPath: string,
  config: MediaInjectConfig,
  tempDir: string
): Promise<CompressedBinary[]> {
  const framePattern = path.join(tempDir, 'frame-%03d.jpg')
  const interval = Math.max(1, Math.floor(config.longVideoFrameIntervalSec))
  const resolution = Math.max(240, Math.floor(config.videoResolution))

  await runCommand(
    ffmpeg,
    [
      '-y',
      '-i',
      inputPath,
      '-vf',
      `fps=1/${interval},scale=-2:${resolution}`,
      '-q:v',
      '5',
      framePattern,
    ],
    config.ffmpegTimeoutMs
  )

  const files = (await readdir(tempDir))
    .filter((item) => item.startsWith('frame-') && item.endsWith('.jpg'))
    .sort()
    .slice(0, Math.max(1, config.longVideoMaxFrames))

  const frames: CompressedBinary[] = []
  for (const file of files) {
    const buffer = await readFile(path.join(tempDir, file))
    if (!buffer.length) {
      continue
    }
    frames.push({
      buffer,
      mimeType: 'image/jpeg',
      ext: '.jpg',
    })
  }

  return frames
}

async function extractVideoAudio(
  ffmpeg: string,
  inputPath: string,
  config: MediaInjectConfig,
  tempDir: string,
  logger: Logger
): Promise<CompressedBinary | undefined> {
  const outputPath = path.join(tempDir, 'audio.m4a')

  try {
    await runCommand(
      ffmpeg,
      ['-y', '-i', inputPath, '-vn', '-c:a', 'copy', outputPath],
      config.ffmpegTimeoutMs
    )
  } catch {
    try {
      await runCommand(
        ffmpeg,
        ['-y', '-i', inputPath, '-vn', '-c:a', 'aac', '-b:a', '128k', outputPath],
        config.ffmpegTimeoutMs
      )
    } catch (error) {
      logger.info(`audio extract failed: ${String((error as Error)?.message || error)}`)
      return undefined
    }
  }

  const buffer = await readFile(outputPath)
  if (!buffer.length) {
    return undefined
  }

  return {
    buffer,
    mimeType: 'audio/mp4',
    ext: '.m4a',
  }
}

/**
 * Probe the duration of a video buffer in seconds.
 * Returns null if ffprobe is not available or fails.
 */
export async function probeVideoDuration(input: Buffer, mimeType: string, timeoutMs: number): Promise<number | null> {
  const ffprobe = await resolveFfprobeBinary()
  if (!ffprobe) {
    return null
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'social-media-probe-'))
  const inputPath = path.join(tempDir, `input${extensionFromMime(mimeType)}`)
  try {
    await writeFile(inputPath, input)
    return await readVideoDuration(ffprobe, inputPath, timeoutMs)
  } finally {
    await safeCleanup(tempDir)
  }
}

/**
 * Merge video and audio buffers using ffmpeg.
 * Used for DASH streams where video and audio are separate (e.g., Bilibili).
 */
export async function mergeVideoAudioBuffers(
  videoBuffer: Buffer,
  videoMime: string,
  audioBuffer: Buffer,
  audioMime: string,
  timeoutMs: number,
  logger?: Logger,
  knownDurationSec?: number
): Promise<Buffer | null> {
  const ffmpeg = await resolveFfmpegBinary()
  if (!ffmpeg) {
    logger?.warn('mergeVideoAudioBuffers: ffmpeg not available')
    return null
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'social-media-merge-'))
  const videoPath = path.join(tempDir, `video${extensionFromMime(videoMime)}`)
  const audioPath = path.join(tempDir, `audio${extensionFromMime(audioMime)}`)
  const outputPath = path.join(tempDir, 'merged.mp4')

  try {
    await writeFile(videoPath, videoBuffer)
    await writeFile(audioPath, audioBuffer)

    // Use known duration from API if available, otherwise probe the video file
    let dynamicTimeoutMs = timeoutMs
    let durationSec: number | null = knownDurationSec && knownDurationSec > 0 ? knownDurationSec : null

    if (durationSec) {
      // Calculate dynamic timeout based on API-provided duration
      const processingTimeMs = Math.round(Math.max(30_000, Math.min(300_000, durationSec * 1000 / 3)))
      dynamicTimeoutMs = Math.round(Math.max(timeoutMs, processingTimeMs))
      logger?.warn(`[social-media-parser] mergeVideoAudioBuffers: using timeout ${dynamicTimeoutMs}ms based on API duration ${durationSec}s`)
    } else {
      // Fallback to ffprobe if no API duration provided
      const ffprobe = await resolveFfprobeBinary()
      if (ffprobe) {
        const probedDuration = await readVideoDuration(ffprobe, videoPath, 10_000)
        if (probedDuration && probedDuration > 0) {
          durationSec = probedDuration
          const processingTimeMs = Math.round(Math.max(30_000, Math.min(300_000, probedDuration * 1000 / 3)))
          dynamicTimeoutMs = Math.round(Math.max(timeoutMs, processingTimeMs))
          logger?.warn(`[social-media-parser] mergeVideoAudioBuffers: video duration ${probedDuration}s (probed), using timeout ${dynamicTimeoutMs}ms`)
        }
      }
    }

    logger?.warn(`[social-media-parser] mergeVideoAudioBuffers: ffmpeg available, merging...`)

    await runCommand(
      ffmpeg,
      [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        outputPath,
      ],
      dynamicTimeoutMs
    )

    const buffer = await readFile(outputPath)
    if (!buffer.length) {
      logger?.warn('mergeVideoAudioBuffers: output file is empty')
      return null
    }

    logger?.warn(`[social-media-parser] mergeVideoAudioBuffers success: output size=${buffer.length}`)
    return buffer
  } catch (error) {
    logger?.warn(`mergeVideoAudioBuffers failed: ${String((error as Error)?.message || error)}`)
    return null
  } finally {
    await safeCleanup(tempDir)
  }
}

async function readVideoDuration(ffprobe: string, inputPath: string, timeoutMs: number): Promise<number | null> {
  try {
    const output = await runCommand(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      timeoutMs
    )

    const duration = Number.parseFloat(output.trim())
    if (Number.isFinite(duration) && duration > 0) {
      return duration
    }
    return null
  } catch {
    return null
  }
}

async function runCommand(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = (stderr || stdout || String(error)).trim()
          reject(new Error(details || (error as Error).message))
          return
        }
        resolve(stdout)
      }
    )
  })
}

function mapImageQualityToQscale(quality: number): number {
  const normalized = Math.max(1, Math.min(100, quality))
  const mapped = Math.round(31 - (normalized / 100) * 26)
  return Math.max(2, Math.min(31, mapped))
}

// Module-level paths set by the plugin (avoids polluting process.env)
let configuredFfmpegPath: string | null = null
let configuredFfprobePath: string | null = null

/**
 * Set ffmpeg/ffprobe paths from Koishi ffmpeg service.
 * This avoids modifying process.env which can affect other plugins.
 */
export function setFfmpegPaths(ffmpegPath: string | null, ffprobePath: string | null): void {
  configuredFfmpegPath = ffmpegPath
  configuredFfprobePath = ffprobePath
}

async function resolveFfmpegBinary(): Promise<string | null> {
  // Prefer configured path from Koishi ffmpeg service
  if (configuredFfmpegPath && await canAccessBinary(configuredFfmpegPath)) {
    return configuredFfmpegPath
  }

  const byEnv = process.env.FFMPEG_PATH
  if (byEnv && await canAccessBinary(byEnv)) {
    return byEnv
  }

  try {
    const staticPath = require('ffmpeg-static') as string
    if (staticPath && await canAccessBinary(staticPath)) {
      return staticPath
    }
  } catch {
    // ignore
  }

  if (await canAccessBinary('ffmpeg')) {
    return 'ffmpeg'
  }

  return null
}

async function resolveFfprobeBinary(): Promise<string | null> {
  // Prefer configured path from Koishi ffmpeg service
  if (configuredFfprobePath && await canAccessBinary(configuredFfprobePath)) {
    return configuredFfprobePath
  }

  const byEnv = process.env.FFPROBE_PATH
  if (byEnv && await canAccessBinary(byEnv)) {
    return byEnv
  }

  const derivedFromConfigured = deriveFfprobePathFromFfmpeg(configuredFfmpegPath)
  if (derivedFromConfigured && await canAccessBinary(derivedFromConfigured)) {
    return derivedFromConfigured
  }

  const derivedFromFfmpegEnv = deriveFfprobePathFromFfmpeg(process.env.FFMPEG_PATH)
  if (derivedFromFfmpegEnv && await canAccessBinary(derivedFromFfmpegEnv)) {
    return derivedFromFfmpegEnv
  }

  if (await canAccessBinary('ffprobe')) {
    return 'ffprobe'
  }

  return null
}

function deriveFfprobePathFromFfmpeg(ffmpegPath: string | undefined): string | null {
  if (!ffmpegPath) {
    return null
  }

  if (!ffmpegPath.includes('/')) {
    if (ffmpegPath === 'ffmpeg') {
      return 'ffprobe'
    }
    return null
  }

  const dir = path.dirname(ffmpegPath)
  const ext = path.extname(ffmpegPath)
  const base = path.basename(ffmpegPath, ext)
  const probeBase = base.replace(/ffmpeg/i, 'ffprobe')
  if (probeBase === base) {
    return null
  }

  return path.join(dir, `${probeBase}${ext}`)
}

async function canAccessBinary(bin: string): Promise<boolean> {
  if (!bin) {
    return false
  }

  if (bin.includes('/')) {
    try {
      await access(bin, BINARY_ACCESS)
      return true
    } catch {
      return false
    }
  }

  // For bare commands, verify with which/where
  const command = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(command, [bin], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function safeCleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
