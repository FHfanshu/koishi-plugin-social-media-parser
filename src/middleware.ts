import type { Context } from 'koishi'

import type { Config } from './config'
import { injectParsedContext } from './context'
import { parseSocialUrl } from './parse'
import { DouyinSkipError } from './parsers/douyin'
import { sendParsedContent } from './utils/media'
import { extractSocialUrlsFromSession, isWhitelisted } from './utils/url'

const COOLDOWN_MIN_TTL_MS = 60_000
const COOLDOWN_MAX_ENTRIES = 5_000

export function registerAutoParseMiddleware(
  ctx: Context,
  config: Config,
  cooldownMap: Map<string, number>
): void {
  const logger = ctx.logger('social-media-parser')

  ctx.middleware(async (session, next) => {
    if (!config.enabled || !config.autoParse.enabled) {
      return next()
    }

    if (config.onlyGroup && !session.guildId) {
      return next()
    }

    if (session.userId && session.selfId && session.userId === session.selfId) {
      return next()
    }

    const urls = extractSocialUrlsFromSession(session)
    if (!urls.length) {
      return next()
    }

    cleanupCooldownMap(cooldownMap, Date.now(), config.cooldownMs)

    if (!isWhitelisted(session, config.autoParse.guilds, config.autoParse.users)) {
      return next()
    }

    const limited = urls.slice(0, config.autoParse.maxUrlsPerMessage)

    for (const url of limited) {
      const cooldownKey = `${session.channelId || session.guildId || session.userId}:${url}`
      const lastTime = cooldownMap.get(cooldownKey) ?? 0
      if (Date.now() - lastTime < config.cooldownMs) {
        continue
      }

      cooldownMap.set(cooldownKey, Date.now())

      try {
        const parsed = await parseSocialUrl(ctx, url, config, logger)
        await sendParsedContent(ctx, session, parsed, config, logger)

        if (config.autoParse.injectContext) {
          await injectParsedContext(
            ctx,
            session,
            parsed,
            {
              contextMaxChars: config.autoParse.contextMaxChars,
              injectMedia: config.autoParse.injectMedia,
              mediaInject: config.autoParse.mediaInject,
              maxVideoDurationSec: config.maxVideoDurationSec,
              maxVideoDownloadBytes: config.maxVideoDownloadBytes,
            },
            logger,
            'auto'
          )
        }
      } catch (error) {
        if (error instanceof DouyinSkipError) {
          if (config.douyin.notifyOnSkip) {
            await session.send(error.message)
          }
          continue
        }

        const message = (error as Error)?.message || String(error)
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
