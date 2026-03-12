import type { Context } from 'koishi'

import type { Config } from './config'
import { parseSocialUrl } from './parse'
import { sendParsedContent } from './utils/media'
import { detectPlatformByUrl, extractSocialUrlsFromSession, isBlocked } from './utils/url'

const COOLDOWN_MIN_TTL_MS = 60_000
const COOLDOWN_MAX_ENTRIES = 5_000

export function registerAutoParseMiddleware(
  ctx: Context,
  config: Config,
  cooldownMap: Map<string, number>
): void {
  const logger = ctx.logger('social-media-parser')

  ctx.middleware(async (session, next) => {
    if (!config.autoParse.enabled) {
      return next()
    }

    if (config.autoParse.onlyGroup && !session.guildId) {
      return next()
    }

    if (session.userId && session.selfId && session.userId === session.selfId) {
      return next()
    }

    const urls = extractSocialUrlsFromSession(session)
    if (!urls.length) {
      if (config.debug) {
        const preview = typeof session.content === 'string' ? session.content.slice(0, 180) : ''
        const raw = typeof session.content === 'string' ? session.content : ''
        if (/(douyin|iesdouyin|xiaohongshu|xhslink|bilibili|b23\.tv|twitter|x\.com|t\.co|fxtwitter|vxtwitter)/i.test(raw)) {
          logger.info(`auto parse skipped: no social url detected, channel=${session.channelId || 'unknown'}, preview=${preview}`)
        }
      }
      return next()
    }

    cleanupCooldownMap(cooldownMap, Date.now(), config.network.cooldownMs)

    if (isBlocked(session, config.autoParse.blacklist.guilds, config.autoParse.blacklist.users)) {
      if (config.debug) {
        logger.info(`auto parse blocked by blacklist: guild=${session.guildId || ''}, channel=${session.channelId || ''}, user=${session.userId || ''}`)
      }
      return next()
    }

    const limited = urls.slice(0, config.autoParse.maxUrlsPerMessage)

    const resolvedSet = new Set<string>()

    for (const url of limited) {
      const platform = detectPlatformByUrl(url)
      if (platform && !isPlatformEnabled(config, platform)) {
        if (config.debug) {
          logger.info(`auto parse skipped: ${platform} disabled, url=${url}`)
        }
        continue
      }

      const cooldownKey = `${session.channelId || session.guildId || session.userId}:${url}`
      const lastTime = cooldownMap.get(cooldownKey) ?? 0
      if (Date.now() - lastTime < config.network.cooldownMs) {
        if (config.debug) {
          logger.info(`auto parse cooldown hit: ${url}`)
        }
        continue
      }

      cooldownMap.set(cooldownKey, Date.now())
      if (config.debug) {
        logger.info(`auto parse start: ${url}`)
      }

      try {
        const parsed = await parseSocialUrl(ctx, url, config, logger)

        const resolvedKey = parsed.resolvedUrl || parsed.originalUrl
        if (resolvedSet.has(resolvedKey)) {
          if (config.debug) {
            logger.info(`auto parse skipped duplicate resolved url: ${resolvedKey} (from ${url})`)
          }
          continue
        }
        resolvedSet.add(resolvedKey)

        await sendParsedContent(ctx, session, parsed, config, logger)
      } catch (error) {
        const message = (error as Error)?.message || String(error)

        if (isDisabledParseError(message)) {
          if (config.debug) {
            logger.info(`auto parse skipped: ${message}, url=${url}`)
          }
          continue
        }

        logger.warn(`auto parse failed: ${message}`)
        if (config.debug) {
          try {
            await session.send(`解析失败：${message}`)
          } catch {
            // ignore send failure
          }
        }
      }
    }

    return next()
  })
}

function cleanupCooldownMap(cooldownMap: Map<string, number>, now: number, cooldownMs: number): void {
  if (cooldownMap.size === 0) {
    return
  }

  const ttlMs = Math.max(COOLDOWN_MIN_TTL_MS, cooldownMs * 3)
  for (const [key, lastTimestamp] of cooldownMap) {
    if (now - lastTimestamp > ttlMs) {
      cooldownMap.delete(key)
    }
  }

  if (cooldownMap.size <= COOLDOWN_MAX_ENTRIES) {
    return
  }

  const ordered = [...cooldownMap.entries()].sort((a, b) => a[1] - b[1])
  const overflow = cooldownMap.size - COOLDOWN_MAX_ENTRIES
  for (let i = 0; i < overflow; i += 1) {
    cooldownMap.delete(ordered[i][0])
  }
}

function isPlatformEnabled(config: Config, platform: 'douyin' | 'xiaohongshu' | 'bilibili' | 'twitter'): boolean {
  if (platform === 'douyin') {
    return config.platforms.douyin.enabled
  }
  if (platform === 'xiaohongshu') {
    return config.platforms.xiaohongshu.enabled
  }
  if (platform === 'bilibili') {
    return config.platforms.bilibili.enabled
  }
  if (platform === 'twitter') {
    return config.platforms.twitter.enabled
  }
  return config.platforms.twitter.enabled
}

function isDisabledParseError(message: string): boolean {
  return message.endsWith('解析已禁用。') || message.endsWith('解析已禁用')
}
