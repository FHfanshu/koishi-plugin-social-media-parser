import type { Context } from 'koishi'

import type { Config } from './config'
import type { SocialPlatform } from './types'
import { parseSocialUrl } from './parse'
import { sendParsedContent } from './utils/media'
import { detectPlatformByUrl, extractSocialUrlsFromSession, isGuildBlocked, isUserBlocked } from './utils/url'

const COOLDOWN_MIN_TTL_MS = 60_000
const COOLDOWN_MAX_ENTRIES = 5_000
const COOLDOWN_CLEANUP_INTERVAL_MS = 30_000

// Message deduplication: prevent the same message from being processed multiple times
// This handles cases where OneBot/Koishi may re-deliver messages due to network issues
const MESSAGE_ID_TTL_MS = 120_000 // 2 minutes TTL for message IDs
const MESSAGE_ID_MAX_ENTRIES = 10_000
const RECENT_SENDER_URL_TTL_MS = 90_000
const RECENT_SENDER_URL_MAX_ENTRIES = 15_000

export function registerAutoParseMiddleware(
  ctx: Context,
  config: Config,
  cooldownMap: Map<string, number>
): void {
  const logger = ctx.logger('social-media-parser')

  // Lazy cleanup: only run periodically, not on every message
  let lastCleanupTime = 0

  // Message ID deduplication set
  const processedMessageIds = new Map<string, number>()
  // Sender+URL dedupe: protects against repeated WS delivery with different message IDs
  const recentSenderUrlMap = new Map<string, number>()

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

    const sessionScopeKey = resolveSessionScopeKey(session)
    const senderId = typeof session.userId === 'string' && session.userId ? session.userId : 'unknown'

    // Periodic cleanup instead of per-message
    const now = Date.now()
    if (now - lastCleanupTime > COOLDOWN_CLEANUP_INTERVAL_MS) {
      cleanupCooldownMap(cooldownMap, now, config.network.cooldownMs)
      cleanupMessageIdMap(processedMessageIds, now)
      cleanupRecentSenderUrlMap(recentSenderUrlMap, now)
      lastCleanupTime = now
    }

    // Check if this message has already been processed (deduplication)
    // This prevents duplicate parsing when the same message is re-delivered
    const messageId = session.messageId
    if (messageId) {
      const messageKey = `${sessionScopeKey}:${messageId}`
      if (processedMessageIds.has(messageKey)) {
        if (config.debug) {
          logger.info(`auto parse skipped: duplicate message id=${messageId}`)
        }
        return next()
      }
      // Mark this message as processed
      processedMessageIds.set(messageKey, now)
    }

    if (isUserBlocked(session, config.autoParse.blacklist.users)) {
      if (config.debug) {
        logger.info(`auto parse blocked by user blacklist: user=${session.userId || ''}`)
      }
      return next()
    }

    const limited = urls.slice(0, config.autoParse.maxUrlsPerMessage)
    const legacyBlockedGuilds = config.autoParse.blacklist.guilds || []

    const resolvedSet = new Set<string>()

    for (const url of limited) {
      const platform = detectPlatformByUrl(url)
      const blockedGuilds = getBlockedGuildsByPlatform(config, platform, legacyBlockedGuilds)
      if (blockedGuilds.length > 0 && isGuildBlocked(session, blockedGuilds)) {
        if (config.debug) {
          logger.info(`auto parse blocked by guild blacklist: platform=${platform || 'unknown'}, guild=${session.guildId || ''}, channel=${session.channelId || ''}, url=${url}`)
        }
        continue
      }

      if (platform && !isPlatformEnabled(config, platform)) {
        if (config.debug) {
          logger.info(`auto parse skipped: ${platform} disabled, url=${url}`)
        }
        continue
      }

      const canonicalUrlKey = normalizeUrlForDedup(url)
      const senderUrlKey = `${sessionScopeKey}:${senderId}:${canonicalUrlKey}`
      const nowBySender = Date.now()
      const senderLastTime = recentSenderUrlMap.get(senderUrlKey) ?? 0
      if (nowBySender - senderLastTime < RECENT_SENDER_URL_TTL_MS) {
        if (config.debug) {
          logger.info(`auto parse skipped duplicate sender+url in ttl: ${url}`)
        }
        continue
      }
      // Mark before parse to avoid concurrent duplicate send; clear on parse/send failure.
      recentSenderUrlMap.set(senderUrlKey, nowBySender)

      const cooldownKey = `${sessionScopeKey}:${canonicalUrlKey}`
      const cooldownNow = Date.now()
      const lastTime = cooldownMap.get(cooldownKey) ?? 0
      if (cooldownNow - lastTime < config.network.cooldownMs) {
        if (config.debug) {
          logger.info(`auto parse cooldown hit: ${url}`)
        }
        recentSenderUrlMap.delete(senderUrlKey)
        continue
      }

      cooldownMap.set(cooldownKey, cooldownNow)
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

        const resolvedCanonicalKey = normalizeUrlForDedup(resolvedKey)
        const resolvedCooldownKey = `${sessionScopeKey}:${resolvedCanonicalKey}`
        if (resolvedCooldownKey !== cooldownKey) {
          const resolvedLastTime = cooldownMap.get(resolvedCooldownKey) ?? 0
          const resolvedNow = Date.now()
          if (resolvedNow - resolvedLastTime < config.network.cooldownMs) {
            if (config.debug) {
              logger.info(`auto parse cooldown hit by resolved url: ${resolvedKey} (from ${url})`)
            }
            continue
          }
          cooldownMap.set(resolvedCooldownKey, resolvedNow)
        }

        const resolvedSenderUrlKey = `${sessionScopeKey}:${senderId}:${resolvedCanonicalKey}`
        if (resolvedSenderUrlKey !== senderUrlKey) {
          const resolvedSenderLast = recentSenderUrlMap.get(resolvedSenderUrlKey) ?? 0
          const resolvedSenderNow = Date.now()
          if (resolvedSenderNow - resolvedSenderLast < RECENT_SENDER_URL_TTL_MS) {
            if (config.debug) {
              logger.info(`auto parse skipped duplicate sender+resolvedUrl in ttl: ${resolvedKey} (from ${url})`)
            }
            continue
          }
          recentSenderUrlMap.set(resolvedSenderUrlKey, resolvedSenderNow)
        }

        await sendParsedContent(ctx, session, parsed, config, logger)
      } catch (error) {
        recentSenderUrlMap.delete(senderUrlKey)
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

function cleanupMessageIdMap(messageIdMap: Map<string, number>, now: number): void {
  cleanupTimedMap(messageIdMap, now, MESSAGE_ID_TTL_MS, MESSAGE_ID_MAX_ENTRIES)
}

function cleanupRecentSenderUrlMap(senderUrlMap: Map<string, number>, now: number): void {
  cleanupTimedMap(senderUrlMap, now, RECENT_SENDER_URL_TTL_MS, RECENT_SENDER_URL_MAX_ENTRIES)
}

function cleanupTimedMap(timedMap: Map<string, number>, now: number, ttlMs: number, maxEntries: number): void {
  if (timedMap.size === 0) {
    return
  }

  for (const [key, timestamp] of timedMap) {
    if (now - timestamp > ttlMs) {
      timedMap.delete(key)
    }
  }

  if (timedMap.size <= maxEntries) {
    return
  }

  const ordered = [...timedMap.entries()].sort((a, b) => a[1] - b[1])
  const overflow = timedMap.size - maxEntries
  for (let i = 0; i < overflow; i += 1) {
    timedMap.delete(ordered[i][0])
  }
}

function resolveSessionScopeKey(session: {
  platform?: unknown
  guildId?: unknown
  channelId?: unknown
  userId?: unknown
}): string {
  const platform = typeof session.platform === 'string' && session.platform
    ? session.platform
    : 'unknown'
  const guildId = typeof session.guildId === 'string' ? session.guildId : ''
  const channelId = typeof session.channelId === 'string' ? session.channelId : ''
  const userId = typeof session.userId === 'string' ? session.userId : ''
  const scope = guildId || channelId || userId || 'unknown'
  return `${platform}:${scope}`
}

function normalizeUrlForDedup(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.replace(/\/+$/, '')

    if (host.endsWith('xiaohongshu.com') || host.endsWith('xhslink.com')) {
      const noteMatch = path.match(/\/(?:discovery\/item|explore|item|note|notes|post|detail)\/([^/?#]+)/i)
      if (noteMatch?.[1]) {
        return `xhs:${noteMatch[1]}`
      }
    }

    if (host.endsWith('douyin.com') || host.endsWith('iesdouyin.com')) {
      const workMatch = path.match(/\/(?:video|note)\/([a-zA-Z0-9]+)/i)
      if (workMatch?.[1]) {
        return `douyin:${workMatch[1]}`
      }
    }

    if (
      host.endsWith('bilibili.com')
      || host.endsWith('b23.tv')
      || host.endsWith('bili22.cn')
      || host.endsWith('bili23.cn')
      || host.endsWith('bili33.cn')
      || host.endsWith('bili2233.cn')
    ) {
      const bvMatch = path.match(/\/(BV[a-zA-Z0-9]+)/i)
      if (bvMatch?.[1]) {
        return `bili:${bvMatch[1].toUpperCase()}`
      }
      const avMatch = path.match(/\/av(\d+)/i)
      if (avMatch?.[1]) {
        return `bili:av${avMatch[1]}`
      }
    }

    if (host.endsWith('x.com') || host.endsWith('twitter.com') || host.endsWith('t.co')) {
      const tweetMatch = path.match(/\/status\/(\d+)/i)
      if (tweetMatch?.[1]) {
        return `x:${tweetMatch[1]}`
      }
    }

    return `${host}${path}`
  } catch {
    return url
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
  // Unknown platforms should be disabled by default
  return false
}

function getBlockedGuildsByPlatform(
  config: Config,
  platform: SocialPlatform | null,
  legacyBlockedGuilds: string[],
): string[] {
  const scoped = getPlatformBlockedGuilds(config, platform)
  if (!legacyBlockedGuilds.length) {
    return scoped
  }
  if (!scoped.length) {
    return [...legacyBlockedGuilds]
  }
  return Array.from(new Set([...scoped, ...legacyBlockedGuilds]))
}

function getPlatformBlockedGuilds(config: Config, platform: SocialPlatform | null): string[] {
  if (!platform) {
    return []
  }

  if (platform === 'douyin') {
    return config.platforms.douyin.autoParseBlockedGuilds || []
  }
  if (platform === 'xiaohongshu') {
    return config.platforms.xiaohongshu.autoParseBlockedGuilds || []
  }
  if (platform === 'bilibili') {
    return config.platforms.bilibili.autoParseBlockedGuilds || []
  }
  if (platform === 'twitter') {
    return config.platforms.twitter.autoParseBlockedGuilds || []
  }

  return []
}

function isDisabledParseError(message: string): boolean {
  return message.endsWith('解析已禁用。') || message.endsWith('解析已禁用')
}
