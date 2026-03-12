import { h, segment } from 'koishi'
import type { Context, Logger, Session } from 'koishi'

import type { Config } from '../config'
import { DEFAULT_MEDIA_INJECT_CONFIG } from '../config'
import type { ParsedContent } from '../types'
import { processVideoForContext, probeVideoDuration } from './compress'
import { downloadBuffer } from './http'
import type { DownloadedBuffer } from './http'
import { toDataUri, toMediaUrl } from './storage'
import { isSafePublicHttpUrl } from './url'

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
  const forceTextOnlyForwardForImages = isOneBot && parsed.platform === 'xiaohongshu'

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

  if (parsed.videos.length > 0) {
    const primaryVideo = parsed.videos[0]
    const videoElement = await buildVideoElement(ctx, primaryVideo, parsed, config, logger, isOneBot)

    if (!videoElement) {
      logger.info(`video unavailable or skipped, fallback to image/text: ${primaryVideo}`)
    } else {
      const imageSegments = imageUrls.length > 0
        ? await buildImageSegments(ctx, imageUrls, config, logger)
        : []
      const shouldForwardVideo = isOneBot && config.forward.enabled
      const forwardImageSegments = forceTextOnlyForwardForImages ? [] : imageSegments

      if (shouldForwardVideo) {
        const forwardMode = await sendForwardContentOrPlain(ctx, session, intro, forwardImageSegments, config, logger)
        const shouldSendImagesPlain = forceTextOnlyForwardForImages || forwardMode !== 'full'
        if (shouldSendImagesPlain) {
          await sendMediaPlain(ctx, session, imageSegments, parsed.musicUrl, config, logger)
        } else {
          await sendMediaPlain(ctx, session, [], parsed.musicUrl, config, logger)
        }
        await session.send(videoElement)
      } else {
        await sendIntroPlain(session, intro)
        await sendMediaPlain(ctx, session, imageSegments, parsed.musicUrl, config, logger)
        await session.send(videoElement)
      }

      return
    }
  }

  if (imageUrls.length > 0) {
    const imageSegments = await buildImageSegments(ctx, imageUrls, config, logger)
    const shouldForwardImages = isOneBot && config.forward.enabled
    const forwardImageSegments = forceTextOnlyForwardForImages ? [] : imageSegments

    if (shouldForwardImages) {
      const forwardMode = await sendForwardContentOrPlain(ctx, session, intro, forwardImageSegments, config, logger)
      const shouldSendImagesPlain = forceTextOnlyForwardForImages || forwardMode !== 'full'
      if (shouldSendImagesPlain) {
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
): Promise<any> {
  if (!isSafePublicHttpUrl(url)) {
    logger.warn(`video send skipped by url safety policy: ${url}`)
    return null
  }

  const hasStorage = hasStorageService(ctx)
  const videoSendMode = config.media.videoSendMode
  const knownDurationSec = Number.isFinite(parsed.videoDurationSec)
    ? Number(parsed.videoDurationSec)
    : null
  const allowUnknownDuration =
    (parsed.platform === 'bilibili' || parsed.platform === 'douyin' || parsed.platform === 'xiaohongshu')
    && config.media.fallbackToUrlOnError
  let downloaded: DownloadedBuffer | null = null
  try {
    if (videoSendMode === 'url') {
      if (config.media.maxDurationSec && config.media.maxDurationSec > 0) {
        downloaded = await downloadVideoForSend(ctx, url, config)
        if (!await isDurationAllowed(downloaded, url, config, logger, knownDurationSec, allowUnknownDuration)) {
          return null
        }
      }

      return segment.video(url)
    }

    downloaded = await downloadVideoForSend(ctx, url, config)
    if (!await isDurationAllowed(downloaded, url, config, logger, knownDurationSec, allowUnknownDuration)) {
      return null
    }

    return buildConfiguredVideoElement(ctx, downloaded, config, logger, videoSendMode, hasStorage, isOneBot)
  } catch (error) {
    logger.debug(`video build failed: ${String((error as Error)?.message || error)}`)
    if (!config.media.fallbackToUrlOnError) {
      throw error
    }

    if (config.media.maxDurationSec && config.media.maxDurationSec > 0) {
      const payload = downloaded || await downloadVideoForSend(ctx, url, config).catch(() => null)
      if (!payload) {
        logger.warn(`video fallback: unable to verify duration (download failed), proceeding with url fallback, url=${url}`)
      } else if (!await isDurationAllowed(payload, url, config, logger, knownDurationSec, allowUnknownDuration)) {
        return null
      }
    }

    if (downloaded && videoSendMode !== 'url') {
      return buildConfiguredVideoElement(ctx, downloaded, config, logger, videoSendMode, hasStorage, isOneBot)
    }

    if (!isSafePublicHttpUrl(url)) {
      logger.warn(`video fallback skipped by url safety policy: ${url}`)
      return null
    }

    if (videoSendMode !== 'url' && isOneBot) {
      logger.warn(`video fallback skipped: onebot requires downloaded video for ${videoSendMode} mode, url=${url}`)
      return null
    }

    return segment.video(url)
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
): Promise<any> {
  const optimized = await optimizeVideoBeforeSend(downloaded.buffer, downloaded.mimeType || 'video/mp4', config, logger)
  const finalBuffer = optimized?.buffer || downloaded.buffer
  const finalMime = optimized?.mimeType || downloaded.mimeType || 'video/mp4'

  if (videoSendMode === 'storage') {
    const storedUrl = await toMediaUrl(ctx, finalMime, finalBuffer, 'send_video', logger)
    return buildVideoSegmentFromMediaUrl(storedUrl, finalBuffer)
  }

  if (finalBuffer.length > config.media.maxBytes) {
    logger.warn(`video send skipped: payload too large ${finalBuffer.length} > ${config.media.maxBytes}`)
    return null
  }

  if (videoSendMode === 'base64' || isOneBot || !hasStorage) {
    return segment.video(toDataUri(finalMime, finalBuffer))
  }

  try {
    return h.video(finalBuffer, finalMime)
  } catch {
    return segment.video(toDataUri(finalMime, finalBuffer))
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

async function downloadVideoForSend(ctx: Context, url: string, config: Config): Promise<DownloadedBuffer> {
  const maxVideoBytes = Math.max(config.media.maxBytes, config.media.maxVideoBytes || config.media.maxBytes)
  const referer = inferMediaReferer(url)
  try {
    return await downloadBuffer(ctx, url, config.network.timeoutMs, {
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
    return downloadBuffer(ctx, url, config.network.timeoutMs, {
      headers: {
        accept: '*/*',
      },
      maxBytes: maxVideoBytes,
    })
  }
}

async function isDurationAllowed(
  downloaded: DownloadedBuffer,
  url: string,
  config: Config,
  logger: Logger,
  knownDurationSec: number | null,
  allowUnknownDuration: boolean
): Promise<boolean> {
  if (!config.media.maxDurationSec || config.media.maxDurationSec <= 0) {
    return true
  }

  const durationSec = knownDurationSec && knownDurationSec > 0
    ? knownDurationSec
    : await probeVideoDuration(
      downloaded.buffer,
      downloaded.mimeType || 'video/mp4',
      DEFAULT_MEDIA_INJECT_CONFIG.ffmpegTimeoutMs
    )

  if (durationSec == null) {
    if (allowUnknownDuration) {
      logger.warn(`video duration probe failed, allow unknown duration fallback: ${url}`)
      return true
    }

    logger.warn(`video send skipped: duration probe failed, url=${url}`)
    return false
  }

  if (durationSec > config.media.maxDurationSec) {
    const limitMin = Math.round(config.media.maxDurationSec / 60)
    const actualMin = Math.round(durationSec / 60)
    logger.info(`video send skipped: duration ${actualMin}min exceeds limit ${limitMin}min, url=${url}`)
    return false
  }

  return true
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

    logger.debug(`video optimized before send: ${buffer.length} -> ${processed.video.buffer.length}`)

    return {
      buffer: processed.video.buffer,
      mimeType: processed.video.mimeType || 'video/mp4',
    }
  } catch (error) {
    logger.debug(`video optimize skipped: ${String((error as Error)?.message || error)}`)
    return null
  }
}

async function buildImageSegments(
  ctx: Context,
  urls: string[],
  config: Config,
  logger: Logger,
): Promise<any[]> {
  const imageSegments = [] as any[]
  for (const url of urls) {
    if (!isSafePublicHttpUrl(url)) {
      logger.warn(`image send skipped by url safety policy: ${url}`)
      continue
    }

    // Global image send strategy:
    // 1) direct url first
    // 2) if sending fails: download -> storage url
    // 3) fallback: download -> base64
    imageSegments.push(segment.image(url))
  }

  return imageSegments
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
  const primaryNodes = safeNodes

  if (await trySendForward(session, primaryNodes, logger, 'primary')) {
    return true
  }

  await sleep(600)
  const retryNodes = session.platform === 'onebot'
    ? await rewriteForwardNodesForRetry(ctx, safeNodes, config, logger)
    : safeNodes
  return trySendForward(session, retryNodes, logger, 'retry')
}

async function trySendForward(
  session: Session,
  nodes: any[],
  logger: Logger,
  label: string
): Promise<boolean> {
  if (session.platform === 'onebot') {
    const forwarded = await trySendForwardViaOneBotApi(session, nodes, logger, label)
    if (forwarded) {
      return true
    }
  }

  try {
    await session.send(h('message', { forward: true }, nodes))
    return true
  } catch (error) {
    logger.debug(`forward send failed (${label}): ${String((error as Error)?.message || error)}`)
    return false
  }
}

async function trySendForwardViaOneBotApi(
  session: Session,
  nodes: any[],
  logger: Logger,
  label: string
): Promise<boolean> {
  const onebotNodes = toOneBotForwardNodes(nodes, session)
  if (!onebotNodes.length) {
    return false
  }

  const target = resolveOneBotForwardTarget(session)
  if (!target) {
    logger.debug(`forward onebot api skipped (${label}): missing target`)
    return false
  }

  const internal = (session as any).bot?.internal
  if (!internal) {
    logger.debug(`forward onebot api skipped (${label}): missing internal api`)
    return false
  }

  try {
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

    return true
  } catch (error) {
    logger.debug(`forward onebot api failed (${label}): ${String((error as Error)?.message || error)}`)
    return false
  }
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

async function rewriteForwardNodesForRetry(
  ctx: Context,
  nodes: any[],
  config: Config,
  logger: Logger
): Promise<any[]> {
  return Promise.all(nodes.map((node) => rewriteForwardNodeElement(ctx, node, config, logger)))
}

async function rewriteForwardNodeElement(
  ctx: Context,
  element: any,
  config: Config,
  logger: Logger
): Promise<any> {
  if (!element || typeof element !== 'object') {
    return element
  }

  const attrs = element.attrs && typeof element.attrs === 'object'
    ? { ...element.attrs }
    : element.attrs

  const remoteImageUrl = (
    attrs &&
    (element.type === 'img' || element.type === 'image') &&
    resolveForwardImageUrl(attrs)
  )

  if (remoteImageUrl) {
    const inlined = await inlineForwardImage(ctx, remoteImageUrl, config, logger)
    if (inlined) {
      if (typeof attrs.src === 'string') attrs.src = inlined
      if (typeof attrs.url === 'string') attrs.url = inlined
      if (typeof attrs.file === 'string') attrs.file = inlined
    }
  }

  const children = Array.isArray(element.children)
    ? await Promise.all(element.children.map((child: any) => rewriteForwardNodeElement(ctx, child, config, logger)))
    : element.children

  return {
    ...element,
    attrs,
    children,
  }
}

function resolveForwardImageUrl(attrs: Record<string, any>): string {
  for (const key of ['src', 'url', 'file']) {
    const value = attrs[key]
    if (typeof value === 'string' && value.startsWith('http')) {
      return value
    }
  }

  return ''
}

async function inlineForwardImage(
  ctx: Context,
  url: string,
  config: Config,
  logger: Logger
): Promise<string | null> {
  try {
    const downloaded = await downloadImageForSend(ctx, url, config)
    const mimeType = downloaded.mimeType || 'image/jpeg'
    const storedUrl = await toMediaUrl(ctx, mimeType, downloaded.buffer, 'forward_img', logger)
    if (isHttpMediaUrl(storedUrl) && storedUrl !== url) {
      return storedUrl
    }
    return toDataUri(mimeType, downloaded.buffer)
  } catch (error) {
    logger.debug(`forward image fallback pipeline skipped: ${String((error as Error)?.message || error)}`)
    return null
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
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

  if (parsed.platform === 'twitter' && translatedText) {
    const textPart = config.platforms.twitter.translation.showOriginal
      ? [
          originalText ? `原文：\n${originalText}` : '',
          `翻译：\n${translatedText}`,
        ].filter(Boolean).join('\n\n')
      : `翻译：\n${translatedText}`

    return [
      `【${platformName}解析】${parsed.title || '无标题'}`,
      textPart,
      sourceUrl,
    ].filter(Boolean).join('\n\n')
  }

  return [
    `【${platformName}解析】${parsed.title || '无标题'}`,
    originalText,
    sourceUrl,
  ].filter(Boolean).join('\n\n')
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

  const imageNodes = imageSegments
    .slice(0, remaining)
    .map((image) => h('message', { nickname: config.forward.nickname, userId: session.selfId }, image))

  return [...nodes, ...imageNodes]
}

function splitTextChunks(text: string, chunkSize: number): string[] {
  const normalized = (text || '').trim()
  if (!normalized) {
    return []
  }

  const size = Math.max(80, chunkSize)
  const chunks: string[] = []
  let index = 0
  while (index < normalized.length) {
    chunks.push(normalized.slice(index, index + size))
    index += size
  }

  return chunks
}
