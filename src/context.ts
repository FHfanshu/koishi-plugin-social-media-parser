import { HumanMessage } from '@langchain/core/messages'
import type { Context, Logger, Session } from 'koishi'

import type { MediaInjectConfig } from './config'
import type { ParsedContent } from './types'
import { processVideoForContext, compressImageForContext } from './utils/compress'
import { downloadBuffer } from './utils/http'

export interface InjectContextOptions {
  contextMaxChars: number
  injectMedia: boolean
  mediaInject: MediaInjectConfig
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

  const mediaMessage = await buildMediaInjectionMessage(ctx, parsed, options.mediaInject, logger)
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
  logger: Logger
): Promise<HumanMessage | null> {
  const parts: any[] = [{ type: 'text', text: `以下是 ${parsed.platform} 链接解析到的媒体内容。` }]
  let totalBytes = 0

  for (const imageUrl of parsed.images.slice(0, mediaConfig.maxImages)) {
    try {
      const downloaded = await downloadBuffer(ctx, imageUrl, 20_000)
      const compressed = await compressImageForContext(downloaded.buffer, downloaded.mimeType, mediaConfig, logger)
      if (!compressed) {
        continue
      }

      if (!canAppendBinary(compressed.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
        logger.debug('skip image injection by maxTotalBytes')
        break
      }

      totalBytes += compressed.buffer.length
      parts.push({
        type: 'image_url',
        image_url: {
          url: toDataUri(compressed.mimeType, compressed.buffer),
        },
      })
    } catch (error) {
      logger.debug(`inject image failed: ${String((error as Error)?.message || error)}`)
    }
  }

  if (mediaConfig.videoEnabled && parsed.videos.length > 0) {
    const videoUrl = parsed.videos[0]
    try {
      const downloaded = await downloadBuffer(ctx, videoUrl, 30_000)
      const processed = await processVideoForContext(downloaded.buffer, downloaded.mimeType, mediaConfig, logger)
      if (processed) {
        if (processed.mode === 'short-video' && processed.video) {
          if (canAppendBinary(processed.video.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
            totalBytes += processed.video.buffer.length
            parts.push({
              type: 'video_url',
              video_url: {
                url: toDataUri(processed.video.mimeType, processed.video.buffer),
                mimeType: processed.video.mimeType,
              },
            })
          }
        } else {
          for (const frame of processed.frames) {
            if (!canAppendBinary(frame.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
              break
            }
            totalBytes += frame.buffer.length
            parts.push({
              type: 'image_url',
              image_url: {
                url: toDataUri(frame.mimeType, frame.buffer),
              },
            })
          }

          if (mediaConfig.keepAudio && processed.audio) {
            if (canAppendBinary(processed.audio.buffer.length, totalBytes, mediaConfig.maxTotalBytes)) {
              totalBytes += processed.audio.buffer.length
              parts.push({
                type: 'audio_url',
                audio_url: {
                  url: toDataUri(processed.audio.mimeType, processed.audio.buffer),
                  mimeType: processed.audio.mimeType,
                },
              })
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`inject video failed: ${String((error as Error)?.message || error)}`)
    }
  }

  if (parts.length <= 1) {
    return null
  }

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

function toDataUri(mimeType: string, buffer: Buffer): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

function canAppendBinary(current: number, used: number, max: number): boolean {
  return used + current <= max
}
