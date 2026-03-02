import type { Context, Logger } from 'koishi'

import type { Config } from './config'
import { parseBilibili } from './parsers/bilibili'
import { parseDouyin } from './parsers/douyin'
import { parseXiaohongshu } from './parsers/xiaohongshu'
import type { ParsedContent } from './types'
import { detectPlatformByUrl, normalizeInputUrl } from './utils/url'

export async function parseSocialUrl(
  ctx: Context,
  input: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const normalized = normalizeInputUrl(input)
  if (!normalized) {
    throw new Error('链接无效，或不属于抖音/小红书/B站域名。')
  }

  const platform = detectPlatformByUrl(normalized)
  if (!platform) {
    throw new Error('当前仅支持抖音、小红书和 Bilibili 链接。')
  }

  if (platform === 'douyin') {
    if (!config.douyin.enabled) {
      throw new Error('抖音解析已禁用。')
    }
    return parseDouyin(ctx, normalized, config, logger)
  }

  if (platform === 'bilibili') {
    if (!config.bilibili.enabled) {
      throw new Error('Bilibili 解析已禁用。')
    }
    return parseBilibili(ctx, normalized, config, logger)
  }

  if (!config.xiaohongshu.enabled) {
    throw new Error('小红书解析已禁用。')
  }

  return parseXiaohongshu(ctx, normalized, config, logger)
}
