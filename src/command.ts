import type { Context } from 'koishi'

import type { Config } from './config'
import { parseSocialUrl } from './parse'
import { normalizeInputUrl } from './utils/url'
import { sendParsedContent } from './utils/media'

export function registerParseCommand(ctx: Context, config: Config): void {
  const logger = ctx.logger('social-media-parser')

  ctx.command('parse <url:text>', '解析抖音/小红书链接')
    .alias('social-parse')
    .action(async ({ session }, url) => {
      if (!url) {
        return '请提供要解析的链接。'
      }

      if (!session) {
        return '当前会话不可用。'
      }

      const normalized = normalizeInputUrl(url)
      if (!normalized) {
        return '链接无效，或不属于抖音/小红书域名。'
      }

      try {
        const parsed = await parseSocialUrl(ctx, normalized, config, logger)
        await sendParsedContent(ctx, session, parsed, config, logger)
        return ''
      } catch (error) {
        const message = (error as Error)?.message || String(error)
        logger.warn(`parse command failed: ${message}`)
        return `解析失败：${message}`
      }
    })
}
