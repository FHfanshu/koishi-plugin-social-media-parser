import { h, segment } from 'koishi'
import type { Context, Logger, Session } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { processVideoForContext } from './compress'
import { downloadBuffer } from './http'
import { toMediaUrl } from './storage'

export async function sendParsedContent(
  ctx: Context,
  session: Session,
  parsed: ParsedContent,
  config: Config,
  logger: Logger
): Promise<void> {
  const isOneBot = session.platform === 'onebot'
  const sourceUrl = simplifyDisplayUrl(parsed.resolvedUrl || parsed.originalUrl)
  const platformName = parsed.platform === 'douyin'
    ? '抖音'
    : parsed.platform === 'bilibili'
      ? '哔哩哔哩'
      : '小红书'
  const textBody = parsed.content?.trim() ? truncateText(parsed.content.trim(), 350) : ''

  const intro = [
    `【${platformName}解析】${parsed.title || '无标题'}`,
    textBody,
    sourceUrl,
  ].filter(Boolean).join('\n\n')

  const shouldAutoForward =
    isOneBot
    && config.forward.enabled
    && config.forward.autoMergeForward
    && (
      intro.length >= config.forward.longTextThreshold
      || parsed.images.length >= config.forward.imageMergeThreshold
    )

  if (parsed.videos.length > 0) {
    const primaryVideo = parsed.videos[0]
    const videoElement = await buildVideoElement(ctx, primaryVideo, config, logger)

    if (shouldAutoForward) {
      const nodes = createForwardTextNodes(intro, session, config)
      if (videoElement && nodes.length < config.forward.maxForwardNodes) {
        nodes.push(h('message', { nickname: config.forward.nickname, userId: session.selfId }, videoElement))
      }
      await sendForwardNodes(session, nodes, config, logger)
    } else {
      await session.send(h.text(intro))
      if (videoElement) {
        await session.send(videoElement)
      }
    }

    return
  }

  if (parsed.images.length > 0) {
    const imageSegments = await buildImageSegments(ctx, parsed.images, config, logger)
    const shouldForwardImages =
      isOneBot
      && config.forward.enabled
      && (shouldAutoForward || parsed.images.length >= config.forward.imageMergeThreshold)

    if (shouldForwardImages) {
      const nodes = createForwardTextNodes(intro, session, config)

      for (const image of imageSegments) {
        if (nodes.length >= config.forward.maxForwardNodes) {
          break
        }
        nodes.push(h('message', { nickname: config.forward.nickname, userId: session.selfId }, image))
      }

      if (config.forward.includeMusic && parsed.musicUrl && nodes.length < config.forward.maxForwardNodes) {
        nodes.push(
          h('message', { nickname: config.forward.nickname, userId: session.selfId }, [
            '背景音乐：',
            h('audio', { src: parsed.musicUrl }),
          ])
        )
      }

      await sendForwardNodes(session, nodes, config, logger)
      return
    }

    await session.send(h.text(intro))
    if (imageSegments.length) {
      await session.send(imageSegments)
    }

    if (config.forward.includeMusic && parsed.musicUrl) {
      await session.send(h('audio', { src: parsed.musicUrl }))
    }
    return
  }

  await session.send(h.text(intro))
}

async function buildVideoElement(
  ctx: Context,
  url: string,
  config: Config,
  logger: Logger
): Promise<any> {
  if (config.sendMode === 'url') {
    return segment.video(url)
  }

  try {
    const referer = inferMediaReferer(url)
    let downloaded
    try {
      downloaded = await downloadBuffer(ctx, url, config.timeoutMs, referer ? {
        referer,
        accept: '*/*',
      } : {
        accept: '*/*',
      })
    } catch {
      downloaded = await downloadBuffer(ctx, url, config.timeoutMs, {
        accept: '*/*',
      })
    }
    if (downloaded.buffer.length > config.maxMediaBytes) {
      throw new Error(`video too large: ${downloaded.buffer.length}`)
    }

    const optimized = await optimizeVideoBeforeSend(downloaded.buffer, downloaded.mimeType || 'video/mp4', config, logger)
    const finalBuffer = optimized?.buffer || downloaded.buffer
    const finalMime = optimized?.mimeType || downloaded.mimeType || 'video/mp4'

    try {
      return h.video(finalBuffer, finalMime)
    } catch {
      const storedUrl = await toMediaUrl(ctx, finalMime, finalBuffer, 'send_video', logger)
      if (storedUrl.startsWith('http')) {
        return segment.video(storedUrl)
      }
      const base64 = finalBuffer.toString('base64')
      return segment.video(`base64://${base64}`)
    }
  } catch (error) {
    logger.debug(`video build failed: ${String((error as Error)?.message || error)}`)
    if (!config.fallbackToUrlOnError) {
      throw error
    }
    return segment.video(url)
  }
}

async function optimizeVideoBeforeSend(
  buffer: Buffer,
  mimeType: string,
  config: Config,
  logger: Logger
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const mediaConfig = config.autoParse?.mediaInject
  if (!mediaConfig?.enabled || !mediaConfig.videoEnabled) {
    return null
  }

  const minCompressBytes = Math.min(config.maxMediaBytes, 4 * 1024 * 1024)
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
  logger: Logger
): Promise<any[]> {
  const imageSegments = [] as any[]
  for (const url of urls) {
    if (config.sendMode === 'url') {
      imageSegments.push(segment.image(url))
      continue
    }

    try {
      const downloaded = await downloadBuffer(ctx, url, config.timeoutMs)
      if (downloaded.buffer.length > config.maxMediaBytes) {
        throw new Error(`image too large: ${downloaded.buffer.length}`)
      }

      const storedUrl = await toMediaUrl(ctx, downloaded.mimeType, downloaded.buffer, 'send_img', logger)
      imageSegments.push(segment.image(storedUrl))
    } catch (error) {
      logger.debug(`image base64 send failed: ${String((error as Error)?.message || error)}`)
      if (!config.fallbackToUrlOnError) {
        throw error
      }
      imageSegments.push(segment.image(url))
    }
  }

  return imageSegments
}

async function sendForwardNodes(
  session: Session,
  nodes: any[],
  config: Config,
  logger: Logger
): Promise<void> {
  if (!nodes.length) {
    return
  }

  const safeNodes = nodes.slice(0, config.forward.maxForwardNodes)

  try {
    await session.send(h('message', { forward: true }, safeNodes))
  } catch (error) {
    logger.debug(`forward send failed: ${String((error as Error)?.message || error)}`)
    for (const node of safeNodes) {
      const content = (node as any)?.children?.[0] ?? node
      if (content) {
        await session.send(content)
      }
    }
  }
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
  } catch {
    // ignore
  }

  return ''
}

function createForwardTextNodes(text: string, session: Session, config: Config): any[] {
  const chunks = splitTextChunks(text, config.forward.textChunkSize)
  const limited = chunks.slice(0, Math.max(1, config.forward.maxForwardNodes))
  return limited.map((chunk) => h('message', { nickname: config.forward.nickname, userId: session.selfId }, chunk))
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
