import { StructuredTool } from '@langchain/core/tools'
import type { Context } from 'koishi'
import { z } from 'zod'

import type { Config } from './config'
import { parseSocialUrl } from './parse'
import type { ParsedContent } from './types'

type ChatlunaLike = {
  platform?: {
    registerTool?: (
      name: string,
      options: {
        selector(): boolean
        createTool(): unknown
      },
    ) => (() => void) | undefined
  }
}

class SocialMediaParserTool extends StructuredTool<any> {
  name: string
  description: string
  schema = z.object({
    url: z.string().min(1).describe('要解析的链接（支持抖音/小红书/B站/Twitter(X)）。'),
  })

  private readonly logger: ReturnType<Context['logger']>

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    toolName: string,
    toolDescription: string,
  ) {
    super()
    this.name = sanitizeToolName(toolName, 'read_social_media')
    this.description = sanitizeToolDescription(
      toolDescription,
      '读取抖音/小红书/B站/Twitter(X) 链接并返回结构化信息与媒体资源链接。',
    )
    this.logger = ctx.logger('social-media-parser')
  }

  private unwrapInput(input: unknown): string {
    if (typeof input === 'string') {
      return input
    }

    if (input && typeof input === 'object' && 'url' in input) {
      const url = (input as { url?: unknown }).url
      return typeof url === 'string' ? url : ''
    }

    return ''
  }

  async _call(input: { url: string } | string): Promise<string> {
    const rawUrl = this.unwrapInput(input).trim()
    if (!rawUrl) {
      return '输入为空，请提供要解析的链接。'
    }

    try {
      const parsed = await parseSocialUrl(this.ctx, rawUrl, this.config, this.logger)
      if (this.config.debug) {
        this.logger.info(`[tool:${this.name}] parse success: platform=${parsed.platform}, url=${parsed.resolvedUrl || parsed.originalUrl}`)
      }
      return JSON.stringify(formatToolOutput(parsed), null, 2)
    } catch (error) {
      const message = (error as Error)?.message || String(error)
      if (this.config.debug) {
        this.logger.info(`[tool:${this.name}] parse failed: ${message}`)
      } else {
        this.logger.warn(`[tool:${this.name}] parse failed: ${message}`)
      }
      return `解析失败：${message}`
    }
  }
}

export function registerSocialMediaTool(ctx: Context, config: Config): void {
  const logger = ctx.logger('social-media-parser')

  if (!config.tool?.enabled) {
    logger.info('[tool] read_social_media disabled by config')
    return
  }

  const chatluna = (ctx as Context & { chatluna?: ChatlunaLike }).chatluna
  if (!chatluna?.platform?.registerTool) {
    logger.warn('[tool] chatluna.platform.registerTool unavailable, skip tool registration')
    return
  }

  const toolName = sanitizeToolName(config.tool.name, 'read_social_media')
  const toolDescription = sanitizeToolDescription(
    config.tool.description,
    '读取抖音/小红书/B站/Twitter(X) 链接并返回结构化信息与媒体资源链接。',
  )

  ctx.effect(() => {
    logger.info(`[tool] register ${toolName}`)
    const dispose = chatluna.platform?.registerTool?.(toolName, {
      selector() {
        return true
      },
      createTool() {
        return new SocialMediaParserTool(ctx, config, toolName, toolDescription)
      },
    })

    return () => {
      if (typeof dispose === 'function') {
        dispose()
      }
    }
  })
}

function formatToolOutput(parsed: ParsedContent): Record<string, unknown> {
  const url = parsed.resolvedUrl || parsed.originalUrl
  const output: Record<string, unknown> = {
    platform: parsed.platform,
    title: parsed.title || '未命名内容',
    author: parsed.author || '',
    url,
  }

  if (parsed.platform === 'bilibili') {
    output.description = parsed.content || ''
  } else {
    output.content = parsed.content || ''
  }

  if (parsed.translatedContent) {
    output.translatedContent = parsed.translatedContent
  }

  const resources = buildResources(parsed)
  if (Object.keys(resources).length > 0) {
    output.resources = resources
  }

  if (parsed.extra && Object.keys(parsed.extra).length > 0) {
    output.extra = parsed.extra
  }

  output.note = 'If you have the `read_files` tool, you can try using it to read media content (including images, audio, and video).'

  return output
}

function buildResources(parsed: ParsedContent): Record<string, unknown> {
  const resources: Record<string, unknown> = {}

  if (parsed.images.length > 0) {
    resources.images = parsed.images
    resources.image = parsed.images[0]
    if (parsed.platform === 'bilibili') {
      resources.cover = parsed.images[0]
    }
  }

  if (parsed.videos.length > 0) {
    resources.videos = parsed.videos
    resources.video = parsed.videos[0]
  }

  if (parsed.audios && parsed.audios.length > 0) {
    resources.audios = parsed.audios
    resources.audio = parsed.audios[0]
  }

  if (parsed.musicUrl) {
    resources.music = parsed.musicUrl
  }

  if (parsed.imageFallbackUrls && parsed.imageFallbackUrls.length > 0) {
    resources.imageFallbackUrls = parsed.imageFallbackUrls
  }

  return resources
}

function sanitizeToolName(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    return fallback
  }

  const normalized = text
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)

  return normalized || fallback
}

function sanitizeToolDescription(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}
