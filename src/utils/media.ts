import { h, segment } from 'koishi'
import type { Context, Logger, Session } from 'koishi'

import type { Config } from '../config'
import { DEFAULT_MEDIA_INJECT_CONFIG } from '../config'
import type { ParsedContent } from '../types'
import { mergeVideoAudioBuffers, processVideoForContext } from './compress'
import { downloadBuffer } from './http'
import type { DownloadedBuffer } from './http'
import { toDataUri, toMediaUrl } from './storage'
import { isSafePublicHttpUrl } from './url'
import { generateCacheKey, VideoCacheManager, type VideoCacheConfig } from './video-cache'

// Video skip reason types for user-friendly messages
type VideoSkipReason =
  | { type: 'duration_exceeded'; durationMin: number; limitMin: number }
  | { type: 'size_exceeded'; sizeMb: number; limitMb: number }
  | { type: 'download_failed'; error: string }
  | { type: 'url_unsafe' }
  | { type: 'onebot_requires_download' }
  | { type: 'other'; message: string }

type VideoBuildResult =
  | { success: true; element: any }
  | { success: false; reason: VideoSkipReason }

// Module-level video cache manager (set by the plugin)
let videoCacheManager: VideoCacheManager | null = null

/**
 * Set the video cache manager instance.
 * Called from the plugin initialization.
 */
export function setVideoCacheManager(manager: VideoCacheManager | null): void {
  videoCacheManager = manager
}

export async function sendParsedContent(
  ctx: Context,
  session: Session,
  parsed: ParsedContent,
  config: Config,
  logger: Logger
): Promise<void> {
  const isOneBot = session.platform === 'onebot'
  const sourceUrl = simplifyDisplayUrl(parsed.resolvedUrl || parsed.originalUrl)
  const platformName = getPlatformName(parsed.platform)
  const intro = buildIntroText(platformName, parsed, sourceUrl, config)
  const imageUrls = resolveImageUrlsForSend(parsed, config)

  const shouldAutoForward =
    isOneBot
    && config.forward.enabled
    && config.forward.autoMergeForward
    && (
      intro.length >= config.forward.longTextThreshold
      || imageUrls.length >= config.forward.imageMergeThreshold
    )

  const mediaFileCount = imageUrls.length + parsed.videos.length + (config.forward.includeMusic && parsed.musicUrl ? 1 : 0)
  const shouldForwardByMediaCount =
    isOneBot
    && config.forward.enabled
    && config.forward.autoMergeForward
    && mediaFileCount > 1

  // Build image segments first (fast operation)
  const imageSegments = imageUrls.length > 0
    ? await buildImageSegments(ctx, imageUrls, config, logger)
    : []

  // If there's a video, process it in background while sending images/text first
  if (parsed.videos.length > 0) {
    const primaryVideo = parsed.videos[0]

    // Send text/images immediately (don't wait for video)
    const shouldForwardVideo = isOneBot && config.forward.enabled

    if (shouldForwardVideo) {
      const forwardResult = await sendForwardContentOrPlain(ctx, session, intro, imageSegments, config, logger)
      if (forwardResult !== 'full') {
        await sendMediaPlain(ctx, session, imageSegments, parsed.musicUrl, config, logger)
      } else {
        await sendMediaPlain(ctx, session, [], parsed.musicUrl, config, logger)
      }
    } else {
      await sendIntroPlain(session, intro)
      await sendMediaPlain(ctx, session, imageSegments, parsed.musicUrl, config, logger)
    }

    // Now process and send video (potentially slow)
    const result = await buildVideoElement(ctx, primaryVideo, parsed, config, logger, isOneBot)

    if (result.success) {
      await session.send(result.element)
      return
    }

    // Video build failed, send user-friendly message
    const reason = (result as { success: false; reason: VideoSkipReason }).reason
    const skipMessage = buildVideoSkipMessage(reason, platformName, sourceUrl)
    if (skipMessage) {
      logger.info(`sending video skip message to user: ${skipMessage.split('\n')[0]}...`)
      await session.send(skipMessage)
    }
    logger.info(`video unavailable: ${JSON.stringify(reason)}`)
    return
  }

  // No video, send images/text normally
  if (imageUrls.length > 0) {
    const shouldForwardImages = isOneBot && config.forward.enabled

    if (shouldForwardImages) {
      const forwardMode = await sendForwardContentOrPlain(ctx, session, intro, imageSegments, config, logger)
      // Only send music, remaining images are truncated to avoid timeout
      if (forwardMode !== 'full') {
        await sendMediaPlain(ctx, session, imageSegments, parsed.musicUrl, config, logger)
      } else {
        await sendMediaPlain(ctx, session, [], parsed.musicUrl, config, logger)
      }
      return
    }

    await sendIntroPlain(session, intro)
    await sendMediaPlain(ctx, session, imageSegments, parsed.musicUrl, config, logger)
    return
  }

  const shouldForwardTextOnly =
    isOneBot
    && config.forward.enabled
    && config.forward.autoMergeForward
    && (intro.length >= config.forward.longTextThreshold || shouldForwardByMediaCount)

  if (shouldForwardTextOnly) {
    const nodes = createForwardTextNodes(intro, session, config)
    const forwarded = await sendForwardNodes(ctx, session, nodes, config, logger)
    if (forwarded) {
      await sendMediaPlain(ctx, session, [], parsed.musicUrl, config, logger)
      return
    }
  }

  await sendIntroPlain(session, intro)
  await sendMediaPlain(ctx, session, [], parsed.musicUrl, config, logger)
}

function getPlatformName(platform: ParsedContent['platform']): string {
  switch (platform) {
    case 'douyin':
      return '抖音'
    case 'bilibili':
      return '哔哩哔哩'
    case 'twitter':
      return 'Twitter/X'
    default:
      return '小红书'
  }
}

function buildVideoSkipMessage(
  reason: VideoSkipReason,
  platformName: string,
  sourceUrl: string
): string | null {
  switch (reason.type) {
    case 'duration_exceeded':
      return `视频太长啦！（${reason.durationMin}分钟 > ${reason.limitMin}分钟限制）\n去${platformName}看吧！\n${sourceUrl}`

    case 'size_exceeded':
      return `视频太大啦！（${reason.sizeMb}MB > ${reason.limitMb}MB限制）\n去${platformName}看吧！\n${sourceUrl}`

    case 'download_failed':
    case 'onebot_requires_download':
      return `视频获取失败，去${platformName}看吧！\n${sourceUrl}`

    case 'url_unsafe':
    case 'other':
    default:
      return null
  }
}

function resolveImageUrlsForSend(parsed: ParsedContent, config: Config): string[] {
  const primary = Array.isArray(parsed.images) ? parsed.images : []
  if (parsed.platform !== 'twitter') {
    return dedupeUrls(primary)
  }

  const fallback = Array.isArray(parsed.imageFallbackUrls) ? parsed.imageFallbackUrls : []
  const merged = dedupeUrls([...primary, ...fallback])
  const limit = Math.max(1, config.platforms.twitter.maxImages || 1)
  return merged.slice(0, limit)
}

async function buildVideoElement(
  ctx: Context,
  url: string,
  parsed: ParsedContent,
  config: Config,
  logger: Logger,
  isOneBot: boolean
): Promise<VideoBuildResult> {
  if (!isSafePublicHttpUrl(url)) {
    logger.warn(`video send skipped by url safety policy: ${url}`)
    return { success: false, reason: { type: 'url_unsafe' } }
  }

  const hasStorage = hasStorageService(ctx)
  const videoSendMode = config.media.videoSendMode
  const knownDurationSec = Number.isFinite(parsed.videoDurationSec)
    ? Number(parsed.videoDurationSec)
    : null
  const allowUnknownDuration =
    (parsed.platform === 'bilibili' || parsed.platform === 'douyin' || parsed.platform === 'xiaohongshu' || parsed.platform === 'twitter')
    && config.media.fallbackToUrlOnError

  // Check if we need to merge audio for DASH streams (Bilibili)
  const audioUrl = parsed.audios?.[0]
  const needsAudioMerge = audioUrl && isSafePublicHttpUrl(audioUrl)

  logger.warn(`[social-media-parser] buildVideoElement: platform=${parsed.platform}, videoUrl=${url.substring(0, 80)}..., audioUrl=${audioUrl ? audioUrl.substring(0, 80) + '...' : 'none'}, needsAudioMerge=${needsAudioMerge}`)

  let downloaded: DownloadedBuffer | null = null
  try {
    if (videoSendMode === 'url' && !needsAudioMerge) {
      if (config.media.maxDurationSec && config.media.maxDurationSec > 0) {
        downloaded = await downloadVideoForSend(ctx, url, config, logger)
        const durationCheck = await isDurationAllowed(downloaded, url, config, logger, knownDurationSec, allowUnknownDuration)
        if (!durationCheck.allowed) {
          return { success: false, reason: durationCheck.reason! }
        }
      }

      return { success: true, element: segment.video(url) }
    }

    // Download video (and audio if needed for DASH merge)
    downloaded = await downloadVideoForSend(ctx, url, config, logger)

    // Merge audio if available (Bilibili DASH streams)
    if (needsAudioMerge) {
      const merged = await mergeVideoAudio(ctx, downloaded, audioUrl, config, logger, knownDurationSec ?? undefined)
      if (merged) {
        downloaded = merged
      } else {
        // 音频合并失败时直接报错，不发送无声音的视频
        logger.warn(`video audio merge failed, skipping video: ${url}`)
        return { success: false, reason: { type: 'download_failed', error: 'audio merge failed' } }
      }
    }

    const durationCheck = await isDurationAllowed(downloaded, url, config, logger, knownDurationSec, allowUnknownDuration)
    if (!durationCheck.allowed) {
      return { success: false, reason: durationCheck.reason! }
    }

    return buildConfiguredVideoElement(ctx, downloaded, config, logger, videoSendMode, hasStorage, isOneBot)
  } catch (error) {
    const errorMsg = String((error as Error)?.message || error)
    logger.info(`video build failed: ${errorMsg}`)
    if (!config.media.fallbackToUrlOnError) {
      return { success: false, reason: { type: 'download_failed', error: errorMsg } }
    }

    if (config.media.maxDurationSec && config.media.maxDurationSec > 0) {
      const payload = downloaded || await downloadVideoForSend(ctx, url, config, logger).catch(() => null)
      if (!payload) {
        logger.warn(`video fallback: unable to verify duration (download failed), proceeding with url fallback, url=${url}`)
      } else {
        const durationCheck = await isDurationAllowed(payload, url, config, logger, knownDurationSec, allowUnknownDuration)
        if (!durationCheck.allowed) {
          return { success: false, reason: durationCheck.reason! }
        }
      }
    }

    if (downloaded && videoSendMode !== 'url') {
      return buildConfiguredVideoElement(ctx, downloaded, config, logger, videoSendMode, hasStorage, isOneBot)
    }

    if (!isSafePublicHttpUrl(url)) {
      logger.warn(`video fallback skipped by url safety policy: ${url}`)
      return { success: false, reason: { type: 'url_unsafe' } }
    }

    if (videoSendMode !== 'url' && isOneBot) {
      logger.warn(`video fallback skipped: onebot requires downloaded video for ${videoSendMode} mode, url=${url}`)
      return { success: false, reason: { type: 'onebot_requires_download' } }
    }

    return { success: true, element: segment.video(url) }
  }
}

async function buildConfiguredVideoElement(
  ctx: Context,
  downloaded: DownloadedBuffer,
  config: Config,
  logger: Logger,
  videoSendMode: Config['media']['videoSendMode'],
  hasStorage: boolean,
  isOneBot: boolean
): Promise<VideoBuildResult> {
  const optimized = await optimizeVideoBeforeSend(downloaded.buffer, downloaded.mimeType || 'video/mp4', config, logger)
  const finalBuffer = optimized?.buffer || downloaded.buffer
  const finalMime = optimized?.mimeType || downloaded.mimeType || 'video/mp4'

  if (videoSendMode === 'storage') {
    const storedUrl = await toMediaUrl(ctx, finalMime, finalBuffer, 'send_video', logger)
    const element = buildVideoSegmentFromMediaUrl(storedUrl, finalBuffer)
    return { success: true, element }
  }

  if (finalBuffer.length > config.media.maxBytes) {
    const sizeMb = Math.round(finalBuffer.length / 1024 / 1024)
    const limitMb = Math.round(config.media.maxBytes / 1024 / 1024)
    logger.warn(`video send skipped: payload too large ${finalBuffer.length} > ${config.media.maxBytes}`)
    return { success: false, reason: { type: 'size_exceeded', sizeMb, limitMb } }
  }

  if (videoSendMode === 'base64' || isOneBot || !hasStorage) {
    return { success: true, element: segment.video(toDataUri(finalMime, finalBuffer)) }
  }

  try {
    return { success: true, element: h.video(finalBuffer, finalMime) }
  } catch {
    return { success: true, element: segment.video(toDataUri(finalMime, finalBuffer)) }
  }
}

function buildVideoSegmentFromMediaUrl(mediaUrl: string, buffer: Buffer): any {
  if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
    return segment.video(mediaUrl)
  }

  if (mediaUrl.startsWith('data:')) {
    return segment.video(mediaUrl)
  }

  if (mediaUrl.startsWith('base64://')) {
    return segment.video(toDataUri('video/mp4', buffer))
  }

  return segment.video(toDataUri('video/mp4', buffer))
}

function hasStorageService(ctx: Context): boolean {
  const storage = (ctx as any).chatluna_storage
  return Boolean(storage?.createTempFile)
}

async function downloadVideoForSend(ctx: Context, url: string, config: Config, logger?: Logger): Promise<DownloadedBuffer> {
  const maxVideoBytes = Math.max(config.media.maxBytes, config.media.maxVideoBytes || config.media.maxBytes)
  const referer = inferMediaReferer(url)

  // Generate cache key for simple video URL (non-DASH)
  const cacheKey = generateCacheKey(url)

  // Use cache manager if available and enabled
  if (videoCacheManager && config.media.videoCache?.enabled) {
    return videoCacheManager.getOrDownload(cacheKey, async () => {
      logger?.debug(`video cache: downloading video from ${url.substring(0, 80)}...`)
      return doDownloadVideo(ctx, url, maxVideoBytes, referer, config.network.timeoutMs)
    })
  }

  // Fallback to direct download without caching
  return doDownloadVideo(ctx, url, maxVideoBytes, referer, config.network.timeoutMs)
}

async function doDownloadVideo(
  ctx: Context,
  url: string,
  maxVideoBytes: number,
  referer: string,
  timeoutMs: number
): Promise<DownloadedBuffer> {
  try {
    return await downloadBuffer(ctx, url, timeoutMs, {
      headers: referer
        ? {
            referer,
            accept: '*/*',
          }
        : {
            accept: '*/*',
          },
      maxBytes: maxVideoBytes,
    })
  } catch {
    return downloadBuffer(ctx, url, timeoutMs, {
      headers: {
        accept: '*/*',
      },
      maxBytes: maxVideoBytes,
    })
  }
}

async function mergeVideoAudio(
  ctx: Context,
  video: DownloadedBuffer,
  audioUrl: string,
  config: Config,
  logger: Logger,
  knownDurationSec?: number
): Promise<DownloadedBuffer | null> {
  // Generate cache key for video+audio combination (B站 DASH)
  const mergedCacheKey = generateCacheKey(video.url, audioUrl)

  // Check if merged result is already cached
  if (videoCacheManager && config.media.videoCache?.enabled) {
    const cached = videoCacheManager.get(mergedCacheKey)
    if (cached) {
      logger.debug(`video cache hit for merged DASH stream: ${mergedCacheKey}`)
      return {
        buffer: cached.buffer,
        mimeType: cached.mimeType,
        url: cached.url,
      }
    }
  }

  try {
    const dashMergeMaxBytes = Math.max(config.media.maxBytes, config.media.maxVideoBytes || config.media.maxBytes)
    const audio = await downloadBuffer(ctx, audioUrl, config.network.timeoutMs, {
      headers: {
        referer: 'https://www.bilibili.com/',
        accept: '*/*',
      },
      maxBytes: dashMergeMaxBytes,
    })

    const merged = await mergeVideoAudioBuffers(
      video.buffer,
      video.mimeType || 'video/mp4',
      audio.buffer,
      audio.mimeType || 'audio/mp4',
      DEFAULT_MEDIA_INJECT_CONFIG.ffmpegTimeoutMs,
      logger,
      knownDurationSec
    )

    if (!merged) {
      return null
    }

    logger.warn(`[social-media-parser] merged video and audio streams: ${video.buffer.length} + ${audio.buffer.length} -> ${merged.length} bytes`)

    const result: DownloadedBuffer = {
      buffer: merged,
      mimeType: 'video/mp4',
      url: video.url,
    }

    // Cache the merged result
    if (videoCacheManager && config.media.videoCache?.enabled) {
      videoCacheManager.set(mergedCacheKey, result)
    }

    return result
  } catch (error) {
    logger.warn(`merge video audio failed: ${String((error as Error)?.message || error)}`)
    return null
  }
}

async function isDurationAllowed(
  downloaded: DownloadedBuffer,
  url: string,
  config: Config,
  logger: Logger,
  knownDurationSec: number | null,
  allowUnknownDuration: boolean
): Promise<{ allowed: boolean; reason?: VideoSkipReason }> {
  const maxDurationSec = config.media.maxDurationSec

  if (!maxDurationSec || maxDurationSec <= 0) {
    return { allowed: true }
  }

  // Only use known duration from API, no ffprobe probing
  // Short video platforms (douyin, xiaohongshu, twitter) don't need duration check
  // Bilibili returns duration from API directly
  if (knownDurationSec == null || knownDurationSec <= 0) {
    // Unknown duration - allow through for short video platforms
    return { allowed: true }
  }

  // Check against limit
  if (knownDurationSec > maxDurationSec) {
    const limitMin = Math.round(maxDurationSec / 60)
    const actualMin = Math.round(knownDurationSec / 60)
    logger.info(`video skipped: duration ${actualMin}min exceeds limit ${limitMin}min: source=${url}`)
    return {
      allowed: false,
      reason: { type: 'duration_exceeded', durationMin: actualMin, limitMin }
    }
  }

  return { allowed: true }
}

async function optimizeVideoBeforeSend(
  buffer: Buffer,
  mimeType: string,
  config: Config,
  logger: Logger
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const mediaConfig = DEFAULT_MEDIA_INJECT_CONFIG
  if (!mediaConfig?.enabled || !mediaConfig.videoEnabled) {
    return null
  }

  const minCompressBytes = Math.min(config.media.maxBytes, 4 * 1024 * 1024)
  if (buffer.length < minCompressBytes) {
    return null
  }

  try {
    const processed = await processVideoForContext(buffer, mimeType, mediaConfig, logger)
    if (!processed || processed.mode !== 'short-video' || !processed.video) {
      return null
    }

    if (processed.video.buffer.length >= buffer.length) {
      return null
    }

    logger.info(`video optimized before send: ${buffer.length} -> ${processed.video.buffer.length}`)

    return {
      buffer: processed.video.buffer,
      mimeType: processed.video.mimeType || 'video/mp4',
    }
  } catch (error) {
    logger.info(`video optimize skipped: ${String((error as Error)?.message || error)}`)
    return null
  }
}

async function buildImageSegments(
  ctx: Context,
  urls: string[],
  config: Config,
  logger: Logger,
): Promise<any[]> {
  // Dedupe URLs first to avoid processing the same image multiple times
  const uniqueUrls = dedupeUrls(urls)

  if (uniqueUrls.length !== urls.length) {
    logger.info(`buildImageSegments: deduped ${urls.length} -> ${uniqueUrls.length} URLs`)
  }

  if (config.debug && uniqueUrls.length > 0) {
    logger.info(`buildImageSegments: processing ${uniqueUrls.length} unique URLs`)
  }

  const imageSendMode = config.media.sendMode

  // Download images in parallel and convert to configured send mode.
  const results = await Promise.all(uniqueUrls.map(async (url, index) => {
    // Normalize protocol-relative URLs
    const normalizedUrl = url.startsWith('//') ? `https:${url}` : url

    if (!isSafePublicHttpUrl(normalizedUrl)) {
      logger.warn(`image send skipped by url safety policy: ${url}`)
      return null
    }

    if (imageSendMode === 'url') {
      return segment.image(normalizedUrl)
    }

    // Check if this is a protected CDN URL that won't work as direct URL for OneBot
    const isProtectedCdn = isXiaohongshuCdnUrl(normalizedUrl)

    // Download image and convert to base64/storage URL
    try {
      const downloaded = await downloadImageForSend(ctx, normalizedUrl, config)
      const mimeType = downloaded.mimeType || 'image/jpeg'
      if (imageSendMode === 'base64') {
        return segment.image(toDataUri(mimeType, downloaded.buffer))
      }

      const storedUrl = await toMediaUrl(ctx, mimeType, downloaded.buffer, 'send_img', logger)
      if (isHttpMediaUrl(storedUrl) && storedUrl !== normalizedUrl) {
        return segment.image(storedUrl)
      }
      return segment.image(toDataUri(mimeType, downloaded.buffer))
    } catch (error) {
      // For protected CDNs, skip the image instead of falling back to direct URL
      // because OneBot backend also can't download these protected URLs
      if (isProtectedCdn) {
        logger.warn(`image download failed on protected CDN, skipping: ${normalizedUrl}`)
        return null
      }

      if (config.media.fallbackToUrlOnError) {
        logger.info(`image download failed, fallback to direct URL: ${String((error as Error)?.message || error)}`)
        return segment.image(normalizedUrl)
      }

      logger.warn(`image download failed and url fallback disabled: ${String((error as Error)?.message || error)}`)
      return null
    }
  }))

  return results.filter((seg): seg is any => seg !== null)
}

async function downloadImageForSend(
  ctx: Context,
  url: string,
  config: Config
): Promise<DownloadedBuffer> {
  const candidates = buildImageDownloadCandidates(url)
  let lastError: unknown = null

  for (const candidate of candidates) {
    const referer = inferMediaReferer(candidate)
    try {
      return await downloadBuffer(ctx, candidate, config.network.timeoutMs, {
        headers: referer
          ? {
              referer,
              accept: '*/*',
            }
          : {
              accept: '*/*',
            },
        maxBytes: config.media.maxBytes,
      })
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error(`image download failed: ${url}`)
}

function buildImageDownloadCandidates(url: string): string[] {
  const candidates = [url]
  if (!isTwitterMediaUrl(url)) {
    return candidates
  }

  for (const quality of ['large', 'medium', 'small']) {
    const variant = rewriteTwitterImageQuality(url, quality)
    if (variant && !candidates.includes(variant)) {
      candidates.push(variant)
    }
  }

  return candidates
}

function rewriteTwitterImageQuality(url: string, quality: string): string {
  try {
    const parsed = new URL(url)
    if (!/pbs\.twimg\.com$/i.test(parsed.hostname)) {
      return url
    }

    parsed.searchParams.set('name', quality)
    return parsed.toString()
  } catch {
    return url
  }
}

async function sendForwardNodes(
  ctx: Context,
  session: Session,
  nodes: any[],
  config: Config,
  logger: Logger
): Promise<boolean> {
  if (!nodes.length) {
    return false
  }

  const safeNodes = nodes.slice(0, config.forward.maxForwardNodes)

  // Try OneBot API first if available
  if (session.platform === 'onebot') {
    // Use a shorter timeout to avoid waiting 60s for NapCat resource upload
    // If NapCat takes too long to download/upload images, we should fallback
    // to plain message sending instead of blocking the user experience
    const forwardTimeoutMs = 15_000
    const forwardResult = await trySendForwardViaOneBotApiWithTimeout(
      session, safeNodes, logger, 'onebot-api', forwardTimeoutMs
    )
    if (forwardResult === 'sent') {
      return true
    }

    if (forwardResult === 'timeout') {
      // Fall through to koishi native forward instead of returning true
      logger.warn('forward onebot api timeout, falling back to koishi native forward')
    }

    // OneBot API failed with non-timeout error, fall through to koishi forward
  }

  // Fallback to koishi native forward
  try {
    await session.send(h('message', { forward: true }, safeNodes))
    return true
  } catch (error) {
    logger.info(`forward send failed (koishi-native): ${String((error as Error)?.message || error)}`)
    return false
  }
}

type OneBotForwardResult = 'sent' | 'timeout' | 'failed'

async function trySendForwardViaOneBotApiWithTimeout(
  session: Session,
  nodes: any[],
  logger: Logger,
  label: string,
  timeoutMs: number
): Promise<OneBotForwardResult> {
  const onebotNodes = toOneBotForwardNodes(nodes, session)
  if (!onebotNodes.length) {
    return 'failed'
  }

  const target = resolveOneBotForwardTarget(session)
  if (!target) {
    logger.info(`forward onebot api skipped (${label}): missing target`)
    return 'failed'
  }

  const internal = (session as any).bot?.internal
  if (!internal) {
    logger.info(`forward onebot api skipped (${label}): missing internal api`)
    return 'failed'
  }

  // Create a promise that rejects after timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`forward api timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    // Race between the API call and timeout
    await Promise.race([
      sendForwardMessageViaApi(internal, target, onebotNodes),
      timeoutPromise
    ])
    return 'sent'
  } catch (error) {
    const errorMsg = String((error as Error)?.message || error)

    // Check if this is our own timeout or a network timeout
    if (errorMsg.includes('forward api timeout') || isTimeoutError(errorMsg)) {
      logger.warn(`forward onebot api timeout (${label}): treat as uncertain sent and skip fallback. Error: ${errorMsg}`)
      return 'timeout'
    }

    logger.info(`forward onebot api failed (${label}): ${errorMsg}`)
    return 'failed'
  }
}

async function sendForwardMessageViaApi(
  internal: any,
  target: { type: 'group' | 'private', id: string },
  onebotNodes: any[]
): Promise<void> {
  if (target.type === 'group') {
    await callOneBotApi(internal, 'send_group_forward_msg', {
      group_id: target.id,
      message_seq: 0,
      messages: onebotNodes,
    })
  } else {
    await callOneBotApi(internal, 'send_private_forward_msg', {
      user_id: target.id,
      message_seq: 0,
      messages: onebotNodes,
    })
  }
}

/**
 * Check if an error message indicates a timeout.
 * Timeout errors are special because the message may have already been sent
 * before the error was thrown (e.g., NapCat Highway upload timeout).
 */
function isTimeoutError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('etimedout') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('upload failed')
  )
}

async function callOneBotApi(
  internal: any,
  action: string,
  params: Record<string, unknown>
): Promise<any> {
  if (typeof internal._get === 'function') {
    return internal._get(action, params)
  }
  if (typeof internal.request === 'function') {
    return internal.request(action, params)
  }
  if (typeof internal.callAction === 'function') {
    return internal.callAction(action, params)
  }
  if (typeof internal.sendAction === 'function') {
    return internal.sendAction(action, params)
  }

  throw new Error(`onebot internal api unsupported action: ${action}`)
}

function resolveOneBotForwardTarget(session: Session): { type: 'group' | 'private', id: string } | null {
  const channelId = `${session.channelId || ''}`.trim()
  const guildId = `${session.guildId || ''}`.trim()
  const userId = `${session.userId || ''}`.trim()

  const privateUserId = userId || channelId.replace(/^private:/, '')
  if (session.isDirect && privateUserId) {
    return { type: 'private', id: privateUserId }
  }

  const groupId = guildId || channelId
  if (groupId) {
    return { type: 'group', id: groupId }
  }

  if (privateUserId) {
    return { type: 'private', id: privateUserId }
  }

  return null
}

function toOneBotForwardNodes(nodes: any[], session: Session): Array<{
  type: 'node'
  data: {
    user_id: string
    nickname: string
    message_seq: number
    content: Array<{ type: string, data: Record<string, unknown> }>
  }
}> {
  const result: Array<{
    type: 'node'
    data: {
      user_id: string
      nickname: string
      message_seq: number
      content: Array<{ type: string, data: Record<string, unknown> }>
    }
  }> = []

  for (const node of nodes) {
    if (!node || typeof node !== 'object' || node.type !== 'message') {
      continue
    }

    const attrs = (node.attrs && typeof node.attrs === 'object') ? node.attrs : {}
    const userId = `${attrs.userId || session.selfId || ''}`.trim()
    const nickname = `${attrs.nickname || attrs.username || '内容解析'}`.trim() || '内容解析'
    const content = toOneBotSegments(node.children)
    if (!content.length) {
      continue
    }

    result.push({
      type: 'node',
      data: {
        user_id: userId || `${session.selfId || ''}`.trim() || '0',
        nickname,
        message_seq: 0,
        content,
      },
    })
  }

  return result
}

function toOneBotSegments(children: any): Array<{ type: string, data: Record<string, unknown> }> {
  const list = Array.isArray(children) ? children : (children != null ? [children] : [])
  const segments: Array<{ type: string, data: Record<string, unknown> }> = []

  for (const child of list) {
    if (typeof child === 'string') {
      if (child) {
        segments.push({ type: 'text', data: { text: child } })
      }
      continue
    }

    if (!child || typeof child !== 'object') {
      continue
    }

    const type = `${child.type || ''}`.trim()
    const attrs = (child.attrs && typeof child.attrs === 'object') ? child.attrs : {}

    if (type === 'text') {
      const text = `${attrs.content || ''}`
      if (text) {
        segments.push({ type: 'text', data: { text } })
      }
      continue
    }

    if (type === 'br') {
      segments.push({ type: 'text', data: { text: '\n' } })
      continue
    }

    if (type === 'img' || type === 'image') {
      const source = normalizeOneBotImageFile(attrs)
      if (source) {
        segments.push({ type: 'image', data: { file: source } })
      }
      continue
    }

    if (Array.isArray(child.children) && child.children.length > 0) {
      segments.push(...toOneBotSegments(child.children))
    }
  }

  return segments
}

function normalizeOneBotImageFile(attrs: Record<string, unknown>): string {
  const source = `${attrs.src || attrs.url || attrs.file || ''}`.trim()
  if (!source) {
    return ''
  }

  if (source.startsWith('base64://')) {
    return `data:image/jpeg;base64,${source.slice('base64://'.length)}`
  }

  return source
}

async function sendImagesPlain(
  ctx: Context,
  session: Session,
  intro: string,
  imageSegments: any[],
  musicUrl: string | undefined,
  config: Config,
  logger: Logger
): Promise<void> {
  await sendIntroPlain(session, intro)
  await sendMediaPlain(ctx, session, imageSegments, musicUrl, config, logger)
}

async function sendForwardIntroOrPlain(
  ctx: Context,
  session: Session,
  intro: string,
  config: Config,
  logger: Logger
): Promise<void> {
  const nodes = createForwardTextNodes(intro, session, config)
  if (nodes.length && await sendForwardNodes(ctx, session, nodes, config, logger)) {
    return
  }

  await sendIntroPlain(session, intro)
}

type ForwardContentMode = 'full' | 'text-only' | 'none'

async function sendForwardContentOrPlain(
  ctx: Context,
  session: Session,
  intro: string,
  imageSegments: any[],
  config: Config,
  logger: Logger
): Promise<ForwardContentMode> {
  const contentNodes = createForwardContentNodes(intro, imageSegments, session, config)

  if (contentNodes.length && await sendForwardNodes(ctx, session, contentNodes, config, logger)) {
    return 'full'
  }

  // OneBot can fail on image nodes in merged forward. Fallback to text-only forward first.
  if (imageSegments.length) {
    const textNodes = createForwardTextNodes(intro, session, config)
    if (textNodes.length && await sendForwardNodes(ctx, session, textNodes, config, logger)) {
      if (config.debug) {
        logger.info('forward fallback: text-only merged forward succeeded, images will be sent as plain messages')
      }
      return 'text-only'
    }
  }

  await sendIntroPlain(session, intro)
  return 'none'
}

async function sendIntroPlain(session: Session, intro: string): Promise<void> {
  if (!intro.trim()) {
    return
  }

  await session.send(h.text(intro))
}

async function sendMediaPlain(
  ctx: Context,
  session: Session,
  imageSegments: any[],
  musicUrl: string | undefined,
  config: Config,
  logger: Logger
): Promise<void> {
  if (imageSegments.length) {
    try {
      await session.send(imageSegments)
    } catch (error) {
      logger.warn(`image batch send failed, retry individually: ${String((error as Error)?.message || error)}`)
      for (const imageSegment of imageSegments) {
        try {
          await session.send(imageSegment)
        } catch (singleError) {
          const fallbackSegment = await buildImageSendFallbackAfterDirectFailure(ctx, imageSegment, config, logger)
          if (fallbackSegment) {
            try {
              await session.send(fallbackSegment)
              continue
            } catch (fallbackError) {
              logger.warn(`image fallback send failed: ${String((fallbackError as Error)?.message || fallbackError)}`)
            }
          }

          logger.warn(`image send skipped after retry: ${String((singleError as Error)?.message || singleError)}`)
        }
      }
    }
  }

  if (config.forward.includeMusic && musicUrl) {
    await session.send(h('audio', { src: musicUrl }))
  }
}

async function buildImageSendFallbackAfterDirectFailure(
  ctx: Context,
  imageSegment: any,
  config: Config,
  logger: Logger
): Promise<any | null> {
  const source = resolveImageSegmentSource(imageSegment)
  if (!source || !isSafePublicHttpUrl(source)) {
    return null
  }

  try {
    const downloaded = await downloadImageForSend(ctx, source, config)
    const mimeType = downloaded.mimeType || 'image/jpeg'
    const storedUrl = await toMediaUrl(ctx, mimeType, downloaded.buffer, 'send_img', logger)
    if (isHttpMediaUrl(storedUrl) && storedUrl !== source) {
      return segment.image(storedUrl)
    }

    return segment.image(toDataUri(mimeType, downloaded.buffer))
  } catch (error) {
    logger.warn(`image fallback pipeline failed: ${String((error as Error)?.message || error)}`)
    return null
  }
}

function resolveImageSegmentSource(imageSegment: any): string {
  if (!imageSegment || typeof imageSegment !== 'object') {
    return ''
  }

  const attrs = imageSegment.attrs && typeof imageSegment.attrs === 'object'
    ? imageSegment.attrs as Record<string, unknown>
    : null
  if (!attrs) {
    return ''
  }

  const source = `${attrs.src || attrs.url || attrs.file || ''}`.trim()
  if (!source || source.startsWith('data:') || source.startsWith('base64://')) {
    return ''
  }

  return source
}

function isHttpMediaUrl(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://')
}

function buildIntroText(platformName: string, parsed: ParsedContent, sourceUrl: string, config: Config): string {
  const originalText = parsed.content?.trim() ? truncateText(parsed.content.trim(), 350) : ''
  const translatedText = parsed.translatedContent?.trim() ? truncateText(parsed.translatedContent.trim(), 350) : ''

  // 作者信息：B站显示UP主，小红书显示作者
  const authorLabel = getAuthorLabel(parsed.platform)
  const authorText = parsed.author ? `${authorLabel}：${parsed.author}` : ''

  if (parsed.platform === 'twitter' && translatedText) {
    const textPart = config.platforms.twitter.translation.showOriginal
      ? [
          originalText ? `原文：\n${originalText}` : '',
          `翻译：\n${translatedText}`,
        ].filter(Boolean).join('\n\n')
      : `翻译：\n${translatedText}`

    return [
      `【${platformName}解析】${parsed.title || '无标题'}`,
      authorText,
      textPart,
      sourceUrl,
    ].filter(Boolean).join('\n\n')
  }

  return [
    `【${platformName}解析】${parsed.title || '无标题'}`,
    authorText,
    originalText,
    sourceUrl,
  ].filter(Boolean).join('\n\n')
}

function getAuthorLabel(platform: ParsedContent['platform']): string {
  switch (platform) {
    case 'bilibili':
      return 'UP主'
    case 'xiaohongshu':
      return '作者'
    case 'douyin':
      return '作者'
    default:
      return '作者'
  }
}

function dedupeUrls(urls: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of urls) {
    const value = `${item || ''}`.trim()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    result.push(value)
  }
  return result
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength)}...`
}

function simplifyDisplayUrl(input: string): string {
  try {
    const parsed = new URL(input)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return input
  }
}

function inferMediaReferer(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('douyin.com') || host.includes('iesdouyin.com')) {
      return 'https://www.douyin.com/'
    }
    if (host.includes('xiaohongshu.com') || host.includes('xhscdn.com')) {
      return 'https://www.xiaohongshu.com/'
    }
    if (host.includes('bilibili.com') || host.includes('bilivideo.')) {
      return 'https://www.bilibili.com/'
    }
    if (host.includes('x.com') || host.includes('twitter.com') || host.includes('twimg.com')) {
      return 'https://x.com/'
    }
  } catch {
    // ignore
  }

  return ''
}

function isTwitterMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'pbs.twimg.com' || host.endsWith('.twimg.com') || host === 'video.twimg.com'
  } catch {
    return false
  }
}

function isXiaohongshuCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('.xhscdn.com')
  } catch {
    return false
  }
}

function createForwardTextNodes(text: string, session: Session, config: Config): any[] {
  const chunks = splitTextChunks(text, config.forward.textChunkSize)
  const limited = chunks.slice(0, Math.max(1, config.forward.maxForwardNodes))
  return limited.map((chunk) => h('message', { nickname: config.forward.nickname, userId: session.selfId }, chunk))
}

function createForwardContentNodes(text: string, imageSegments: any[], session: Session, config: Config): any[] {
  const nodes = createForwardTextNodes(text, session, config)
  const remaining = Math.max(0, config.forward.maxForwardNodes - nodes.length)
  if (!remaining || !imageSegments.length) {
    return nodes
  }

  // Limit images in forward message to avoid OneBot timeout
  const maxImages = Math.min(config.forward.maxForwardImages, remaining)

  // Dedupe image segments by their source URL to avoid duplicate images in forward nodes
  const seenImageSources = new Set<string>()
  const dedupedImageSegments: any[] = []
  for (const seg of imageSegments) {
    const source = resolveImageSegmentSource(seg)
    if (source && seenImageSources.has(source)) {
      continue
    }
    if (source) {
      seenImageSources.add(source)
    }
    dedupedImageSegments.push(seg)
    if (dedupedImageSegments.length >= maxImages) {
      break
    }
  }

  const imageNodes = dedupedImageSegments
    .map((image) => h('message', { nickname: config.forward.nickname, userId: session.selfId }, image))

  return [...nodes, ...imageNodes]
}

function splitTextChunks(text: string, chunkSize: number): string[] {
  const normalized = (text || '').trim()
  if (!normalized) {
    return []
  }

  const size = Math.max(80, chunkSize)
  const tokens = tokenizeTextWithUrl(normalized)
  const flattened = tokens.flatMap((token) => {
    if (token.atomic || token.value.length <= size) {
      return token
    }
    return splitPlainTextToken(token.value, size).map((value) => ({ value, atomic: false }))
  })

  const chunks: string[] = []
  let current = ''
  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current)
    }
    current = ''
  }

  for (const token of flattened) {
    if (!token.value) {
      continue
    }

    if (!current) {
      current = token.value
      continue
    }

    if (current.length + token.value.length <= size) {
      current += token.value
      continue
    }

    pushCurrent()
    current = token.value
  }
  pushCurrent()

  return chunks
}

function tokenizeTextWithUrl(text: string): Array<{ value: string, atomic: boolean }> {
  const tokens: Array<{ value: string, atomic: boolean }> = []
  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi
  let cursor = 0
  let matched: RegExpExecArray | null

  while ((matched = urlPattern.exec(text)) !== null) {
    const value = matched[0]
    const start = matched.index
    const end = start + value.length

    if (start > cursor) {
      tokens.push({ value: text.slice(cursor, start), atomic: false })
    }
    tokens.push({ value, atomic: true })
    cursor = end
  }

  if (cursor < text.length) {
    tokens.push({ value: text.slice(cursor), atomic: false })
  }

  return tokens
}

function splitPlainTextToken(text: string, size: number): string[] {
  const parts: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const remaining = text.length - cursor
    if (remaining <= size) {
      parts.push(text.slice(cursor))
      break
    }

    const windowEnd = cursor + size
    const breakPoint = findPreferredBreakPoint(text, cursor, windowEnd)
    if (breakPoint <= cursor) {
      parts.push(text.slice(cursor, windowEnd))
      cursor = windowEnd
      continue
    }

    parts.push(text.slice(cursor, breakPoint))
    cursor = breakPoint
  }

  return parts
}

function findPreferredBreakPoint(text: string, start: number, end: number): number {
  for (let index = end - 1; index > start; index--) {
    if (isPreferredBreakChar(text[index])) {
      return index + 1
    }
  }
  return -1
}

function isPreferredBreakChar(char: string): boolean {
  return /\s/.test(char) || /[.,!?;:)\]}]/.test(char)
}
