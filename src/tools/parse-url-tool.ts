import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager'
import type { RunnableConfig } from '@langchain/core/runnables'
import { Tool } from '@langchain/core/tools'
import type { Context } from 'koishi'

import type { Config } from '../config'
import { injectParsedContext } from '../context'
import { parseSocialUrl } from '../parse'
import type { ParsedContent } from '../types'
import { normalizeInputUrl } from '../utils/url'

type Ctx = Context & {
  chatluna?: {
    platform?: {
      registerTool?: (name: string, tool: any) => (() => void) | undefined
    }
  }
}

export function registerParseUrlTool(ctx: Ctx, config: Config): void {
  const logger = ctx.logger('social-media-parser')
  if (!config.tool.enabled) {
    logger.info('chatluna 工具已禁用，跳过注册')
    return
  }

  const chatluna = ctx.chatluna
  if (!chatluna?.platform?.registerTool) {
    logger.info('未检测到 chatluna.registerTool，跳过工具注册')
    return
  }

  const toolName = (config.tool.toolName || 'parse_social_media').trim() || 'parse_social_media'
  const safeToolName = sanitizeToolName(toolName, 'parse_social_media')
  const safeToolDescription = sanitizeToolDescription(
    config.tool.toolDescription,
    '解析抖音、小红书或 Bilibili 链接，返回标题、正文、图片和视频信息。'
  )

  ctx.effect(() => {
    const dispose = chatluna.platform.registerTool(safeToolName, {
      createTool() {
        return new ParseUrlTool(ctx, config, safeToolName, safeToolDescription)
      },
      selector() {
        return true
      },
    })

    logger.info(`chatluna 工具已注册: ${safeToolName}`)

    return () => {
      if (typeof dispose === 'function') {
        dispose()
      }
    }
  })
}

class ParseUrlTool extends Tool {
  name: string
  description: string

  constructor(
    private readonly ctx: Ctx,
    private readonly config: Config,
    toolName: string,
    toolDescription: string
  ) {
    super()
    this.name = sanitizeToolName(toolName, 'parse_social_media')
    this.description = sanitizeToolDescription(
      toolDescription,
      '解析抖音、小红书或 Bilibili 链接，返回标题、正文、图片和视频信息。'
    )
  }

  async _call(
    input: string,
    _runManager?: CallbackManagerForToolRun,
    parentConfig?: RunnableConfig
  ): Promise<string> {
    const logger = this.ctx.logger('social-media-parser')
    const url = normalizeInputUrl(input)
    if (!url) {
      return '输入中未找到有效的抖音、小红书或 Bilibili 链接。'
    }

    try {
      const parsed = await parseSocialUrl(this.ctx, url, this.config, logger)
      const session = (parentConfig as any)?.configurable?.session

      if (this.config.tool.injectContext && session) {
        await injectParsedContext(
          this.ctx,
          session,
          parsed,
          {
            contextMaxChars: 1500,
            injectMedia: this.config.tool.injectMedia,
            mediaInject: this.config.tool.mediaInject,
          },
          logger,
          'tool'
        )
      }

      return formatToolOutput(parsed, this.config.tool.contentLevel)
    } catch (error) {
      const message = (error as Error)?.message || String(error)
      return `解析失败: ${message}`
    }
  }
}

function formatToolOutput(parsed: ParsedContent, contentLevel: 'summary' | 'full'): string {
  if (contentLevel === 'full') {
    return [
      '[SocialMediaContent]',
      `平台: ${parsed.platform}`,
      `标题: ${parsed.title || '无标题'}`,
      `正文: ${parsed.content || '(无)'}`,
      `图片数量: ${parsed.images.length}`,
      ...parsed.images.map((url, index) => `图片${index + 1}: ${url}`),
      `视频数量: ${parsed.videos.length}`,
      ...parsed.videos.map((url, index) => `视频${index + 1}: ${url}`),
      `来源链接: ${parsed.resolvedUrl || parsed.originalUrl}`,
    ].join('\n')
  }

  return [
    '[SocialMediaContent]',
    `平台: ${parsed.platform}`,
    `标题: ${parsed.title || '无标题'}`,
    `正文摘要: ${truncate(parsed.content || '(无)', 500)}`,
    `图片数量: ${parsed.images.length}`,
    `视频数量: ${parsed.videos.length}`,
    `来源链接: ${parsed.resolvedUrl || parsed.originalUrl}`,
  ].join('\n')
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength)}...`
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
