import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Logger } from 'koishi'

import type { CompressedBinary, ProcessedVideoForContext } from '../types'
import type { MediaInjectConfig } from '../config'
import { extensionFromMime } from './http'

const BINARY_ACCESS = fsConstants.X_OK

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
    logger.debug(`image compress fallback: ${String((error as Error)?.message || error)}`)
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
      logger.debug('video duration probe failed, skip video processing')
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
      logger.debug(`audio extract failed: ${String((error as Error)?.message || error)}`)
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

async function resolveFfmpegBinary(): Promise<string | null> {
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
  const byEnv = process.env.FFPROBE_PATH
  if (byEnv && await canAccessBinary(byEnv)) {
    return byEnv
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

  if (!bin.includes('/')) {
    return true
  }

  try {
    await access(bin, BINARY_ACCESS)
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
