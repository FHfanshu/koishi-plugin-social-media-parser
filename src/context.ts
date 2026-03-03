import { HumanMessage } from '@langchain/core/messages'
import type { Context, Logger, Session } from 'koishi'

import type { MediaInjectConfig } from './config'
import type { ParsedContent } from './types'
import { processVideoForContext, probeVideoDuration, compressImageForContext } from './utils/compress'
import { downloadBuffer } from './utils/http'
import { toMediaUrl } from './utils/storage'
import { isSafePublicHttpUrl } from './utils/url'

export interface InjectContextOptions {
  contextMaxChars: number
  injectMedia: boolean
  mediaInject: MediaInjectConfig
  maxVideoDurationSec?: number
  maxVideoDownloadBytes?: number
}

export async function injectParsedContext(
  ctx: Context,
  session: Session,
  parsed: ParsedContent,
  options: InjectContextOptions,
  logger: Logger,
  source: 'auto' | 'tool'
): Promise<void> {
  const chatluna = (ctx as any).chatluna
  const contextManager = chatluna?.contextManager
  if (!contextManager?.inject) {
    return
  }

  const conversationId = typeof session.guildId === 'string' && session.guildId
    ? session.guildId
    : typeof session.channelId === 'string' && session.channelId
      ? session.channelId
      : ''

  if (!conversationId) {
    return
  }

  const summary = formatSummary(parsed, options.contextMaxChars)
  contextManager.inject({
    conversationId,
    name: `social_media_${source}_summary`,
    value: summary,
    once: true,
    stage: 'injections',
  })

  if (!options.injectMedia || !options.mediaInject.enabled) {
    return
  }

  const mediaMessage = await buildMediaInjectionMessage(
    ctx,
    parsed,
    options.mediaInject,
    options.maxVideoDurationSec ?? 0,
    options.maxVideoDownloadBytes ?? 0,
    logger
  )
  if (!mediaMessage) {
    return
  }

  contextManager.inject({
    conversationId,
    name: `social_media_${source}_media`,
    value: mediaMessage,
    once: true,
    stage: 'after_scratchpad',
  })
}

async function buildMediaInjectionMessage(
  ctx: Context,
  parsed: ParsedContent,
  mediaConfig: MediaInjectConfig,
  maxVideoDurationSec: number,
  maxVideoDownloadBytes: number,
  logger: Logger
): Promise<HumanMessage | null> {
  const parts: any[] = [{ type: 'text', text: `以下是 ${parsed.platform} 链接解析到的媒体内容。` }]
  let totalBytes = 0
  let injectedImageCount = 0
  let injectedFrameCount = 0
  let injectedVideo = false
  let injectedAudio = false
  const skipReasons: string[] = []
  let videoSkipReason = ''

  for (const imageUrl of parsed.images.slice(0, mediaConfig.maxImages)) {
    try {
      const downloaded = await downloadBuffer(ctx, imageUrl, 20_000, {
        maxBytes: mediaConfig.maxTotalBytes,
      })
      const compressed = await compressImageForContext(downloaded.buffer, downloaded.mimeType, mediaConfig, logger)
      if (!compressed) {
        skipReasons.push('image compression returned empty')
        continue
      }

      if (!canAppendBinary(compressed.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
        logger.debug('skip image injection by maxTotalBytes')
        skipReasons.push('image exceeds maxTotalBytes budget')
        break
      }

      totalBytes += compressed.buffer.length
      injectedImageCount += 1
      const storedImageUrl = await toMediaUrl(ctx, compressed.mimeType, compressed.buffer, `img${injectedImageCount}`, logger)
      parts.push({
        type: 'image_url',
        image_url: {
          url: storedImageUrl,
        },
      })
    } catch (error) {
      logger.debug(`inject image failed: ${String((error as Error)?.message || error)}`)
      skipReasons.push('image download/process failed')
    }
  }

  if (mediaConfig.videoEnabled && parsed.videos.length > 0) {
    const videoUrl = parsed.videos[0]
    try {
      const referer = inferMediaReferer(videoUrl)
      const downloaded = await downloadBuffer(
        ctx,
        videoUrl,
        90_000,
        {
          headers: referer ? { referer } : undefined,
          maxBytes: Math.max(mediaConfig.maxTotalBytes, maxVideoDownloadBytes || mediaConfig.maxTotalBytes),
        }
      )

      let shouldProcessVideo = true
      const knownDurationSec = Number.isFinite(parsed.videoDurationSec)
        ? Number(parsed.videoDurationSec)
        : null

      // Duration guard: skip video injection if over the global limit
      if (maxVideoDurationSec && maxVideoDurationSec > 0) {
        const durationSec = knownDurationSec && knownDurationSec > 0
          ? knownDurationSec
          : await probeVideoDuration(downloaded.buffer, downloaded.mimeType, mediaConfig.ffmpegTimeoutMs)

        if (durationSec == null) {
          if (parsed.platform === 'bilibili') {
            logger.warn(`context video duration probe failed, continue with unknown duration: source=${videoUrl}`)
          } else {
            shouldProcessVideo = false
            skipReasons.push('video duration probe failed')
            videoSkipReason = 'video duration probe failed'
            logger.warn(`context video inject skipped: duration probe failed, source=${videoUrl}`)
          }
        } else if (durationSec > maxVideoDurationSec) {
          shouldProcessVideo = false
          const limitMin = Math.round(maxVideoDurationSec / 60)
          const actualMin = Math.round(durationSec / 60)
          logger.info(
            `context video inject skipped: duration ${actualMin}min exceeds limit ${limitMin}min, source=${videoUrl}`
          )
          skipReasons.push(`video duration ${actualMin}min exceeds limit ${limitMin}min`)
          videoSkipReason = `video duration ${actualMin}min exceeds limit ${limitMin}min`
        }
      }

      if (shouldProcessVideo) {
        const processed = await processVideoForContext(downloaded.buffer, downloaded.mimeType, mediaConfig, logger)
        if (processed) {
          if (processed.mode === 'short-video' && processed.video) {
            if (canAppendBinary(processed.video.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
              totalBytes += processed.video.buffer.length
              injectedVideo = true
              const videoMediaUrl = await toMediaUrl(ctx, processed.video.mimeType, processed.video.buffer, 'video', logger)
              parts.push({
                type: 'video_url',
                video_url: {
                  url: videoMediaUrl,
                  mimeType: processed.video.mimeType,
                },
              })
            } else {
              skipReasons.push('short video exceeds maxTotalBytes budget')
              videoSkipReason = 'short video exceeds maxTotalBytes budget'
            }
          } else {
            for (const frame of processed.frames) {
              if (!canAppendBinary(frame.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
                skipReasons.push('video frames exceed maxTotalBytes budget')
                videoSkipReason = 'video frames exceed maxTotalBytes budget'
                break
              }
              totalBytes += frame.buffer.length
              injectedFrameCount += 1
              const frameUrl = await toMediaUrl(ctx, frame.mimeType, frame.buffer, `frame${injectedFrameCount}`, logger)
              parts.push({
                type: 'image_url',
                image_url: {
                  url: frameUrl,
                },
              })
            }

            if (mediaConfig.keepAudio && processed.audio) {
              if (canAppendBinary(processed.audio.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
                totalBytes += processed.audio.buffer.length
                injectedAudio = true
                const audioUrl = await toMediaUrl(ctx, processed.audio.mimeType, processed.audio.buffer, 'audio', logger)
                parts.push({
                  type: 'audio_url',
                  audio_url: {
                    url: audioUrl,
                    mimeType: processed.audio.mimeType,
                  },
                })
              } else {
                skipReasons.push('audio exceeds maxTotalBytes budget')
                videoSkipReason = 'audio exceeds maxTotalBytes budget'
              }
            }
          }
        } else {
          if (parsed.platform === 'bilibili' && isSafePublicHttpUrl(videoUrl)) {
            injectedVideo = true
            parts.push({
              type: 'video_url',
              video_url: {
                url: videoUrl,
                mimeType: downloaded.mimeType || 'video/mp4',
              },
            })
            logger.warn(`context video processing empty, fallback to raw video url: source=${videoUrl}`)
          } else {
            skipReasons.push('video processing returned empty')
            videoSkipReason = 'video processing returned empty'
          }
        }
      }
    } catch (error) {
      logger.debug(`inject video failed: ${String((error as Error)?.message || error)}`)
      skipReasons.push('video download/process failed')
      videoSkipReason = `video download/process failed: ${String((error as Error)?.message || error)}`
    }
  } else if (mediaConfig.videoEnabled) {
    skipReasons.push('no direct video url available')
    videoSkipReason = 'no direct video url available'
  }

  if (parts.length <= 1) {
    logger.info(
      `context media inject skipped: platform=${parsed.platform}, reason=${skipReasons[0] || 'no usable media'}, source=${parsed.resolvedUrl || parsed.originalUrl}`
    )
    return null
  }

  const sourceUrl = parsed.resolvedUrl || parsed.originalUrl
  const videoReasonSuffix = !injectedVideo && injectedFrameCount === 0 && mediaConfig.videoEnabled && videoSkipReason
    ? `, videoReason=${videoSkipReason}`
    : ''
  logger.info(
    `context media injected: platform=${parsed.platform}, images=${injectedImageCount}, video=${injectedVideo ? 1 : 0}, frames=${injectedFrameCount}, audio=${injectedAudio ? 1 : 0}, totalBytes=${totalBytes}, source=${sourceUrl}${videoReasonSuffix}`
  )

  return new HumanMessage({
    content: parts,
  })
}

function formatSummary(parsed: ParsedContent, maxChars: number): string {
  const content = parsed.content?.trim() || ''
  const trimmedContent = content.length > maxChars ? `${content.slice(0, maxChars)}...` : content

  return [
    '[社交媒体内容解析]',
    `平台: ${parsed.platform}`,
    `标题: ${parsed.title || '无标题'}`,
    `正文: ${trimmedContent || '(无)'}`,
    `图片数量: ${parsed.images.length}`,
    `视频数量: ${parsed.videos.length}`,
    `来源链接: ${parsed.resolvedUrl || parsed.originalUrl}`,
  ].join('\n')
}

function canAppendBinary(current: number, used: number, max: number): boolean {
  return used + current <= max
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
