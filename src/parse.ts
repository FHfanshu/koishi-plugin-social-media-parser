import type { Context, Logger } from 'koishi'

import type { Config } from './config'
import { parseBilibili } from './parsers/bilibili'
import { parseDouyin } from './parsers/douyin'
import { parseTwitter } from './parsers/twitter'
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
    throw new Error('链接无效，或不属于抖音/小红书/B站/Twitter(X) 域名。')
  }

  const platform = detectPlatformByUrl(normalized)
  if (!platform) {
    throw new Error('当前仅支持抖音、小红书、Bilibili、Twitter(X) 链接。')
  }

  if (platform === 'douyin') {
    if (!config.platforms.douyin.enabled) {
      throw new Error('抖音解析已禁用。')
    }
    return parseDouyin(ctx, normalized, config, logger)
  }

  if (platform === 'bilibili') {
    if (!config.platforms.bilibili.enabled) {
      throw new Error('Bilibili 解析已禁用。')
    }
    return parseBilibili(ctx, normalized, config, logger)
  }

  if (platform === 'twitter') {
    if (!config.platforms.twitter.enabled) {
      throw new Error('Twitter/X 解析已禁用。')
    }
    return parseTwitter(ctx, normalized, config, logger)
  }

  if (!config.platforms.xiaohongshu.enabled) {
    throw new Error('小红书解析已禁用。')
  }

  return parseXiaohongshu(ctx, normalized, config, logger)
}
