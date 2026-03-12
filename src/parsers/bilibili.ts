import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { requestText, resolveRedirect } from '../utils/http'
import { isSafePublicHttpUrl } from '../utils/url'

const BVID_RE = /BV[0-9a-zA-Z]{10}/i
const AVID_RE = /(?:^|[^a-zA-Z0-9])av(\d+)/i

interface BilibiliVideoId {
  type: 'bv' | 'av'
  value: string
}

interface BilibiliVideoDetail {
  title: string
  description: string
  owner: string
  cover: string
  bvid: string
  aid: string
  cid: string
  durationSec: number
  stats: {
    view: number
    like: number
    coin: number
    favorite: number
    share: number
    danmaku: number
  }
}

export async function parseBilibili(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const finalUrl = await resolveRedirect(ctx, inputUrl, config.network.timeoutMs, logger)
  const videoId = extractVideoId(finalUrl) || extractVideoId(inputUrl)
  if (!videoId) {
    throw new Error('无法从 Bilibili 链接中提取 BV/AV 号')
  }

  const detail = await fetchVideoDetail(ctx, videoId, config)
  const canonicalUrl = detail.bvid ? `https://www.bilibili.com/video/${detail.bvid}` : finalUrl

  let videoUrl = ''
  if (config.platforms.bilibili.fetchVideo) {
    videoUrl = await fetchVideoDirectUrl(ctx, detail, canonicalUrl, config, logger)
    if (!videoUrl) {
      logger.warn(`bilibili video direct link unavailable, fallback to metadata only: ${canonicalUrl}`)
    }
  }

  return {
    platform: 'bilibili',
    title: detail.title,
    author: detail.owner || undefined,
    content: buildContent(detail, config.platforms.bilibili.maxDescLength),
    images: detail.cover ? [detail.cover] : [],
    videos: videoUrl ? [videoUrl] : [],
    videoDurationSec: detail.durationSec > 0 ? detail.durationSec : undefined,
    originalUrl: inputUrl,
    resolvedUrl: canonicalUrl,
  }
}

async function fetchVideoDetail(ctx: Context, videoId: BilibiliVideoId, config: Config): Promise<BilibiliVideoDetail> {
  const query = videoId.type === 'bv'
    ? `bvid=${encodeURIComponent(videoId.value)}`
    : `aid=${encodeURIComponent(videoId.value)}`
  const endpoint = `https://api.bilibili.com/x/web-interface/view?${query}`
  const payload = await requestJson(ctx, endpoint, config.network.timeoutMs)

  const code = toNumber(payload?.code)
  if (code !== 0 || !payload?.data) {
    const reason = typeof payload?.message === 'string' ? payload.message : `code=${code}`
    throw new Error(`Bilibili 元数据获取失败：${reason}`)
  }

  const data = payload.data
  const bvid = normalizeBvid(data?.bvid) || (videoId.type === 'bv' ? normalizeBvid(videoId.value) : '')
  const aid = normalizeAid(data?.aid) || (videoId.type === 'av' ? normalizeAid(videoId.value) : '')
  const cid = normalizeCid(data?.cid) || normalizeCid(data?.pages?.[0]?.cid)
  const title = asString(data?.title).trim() || `bilibili:${bvid || videoId.value}`
  const description = asString(data?.desc).trim()
  const owner = asString(data?.owner?.name).trim()
  const cover = normalizeResourceUrl(asString(data?.pic))
  const durationSec = toNumber(data?.duration)

  return {
    title,
    description,
    owner,
    cover,
    bvid,
    aid,
    cid,
    durationSec,
    stats: {
      view: toNumber(data?.stat?.view),
      like: toNumber(data?.stat?.like),
      coin: toNumber(data?.stat?.coin),
      favorite: toNumber(data?.stat?.favorite),
      share: toNumber(data?.stat?.share),
      danmaku: toNumber(data?.stat?.danmaku),
    },
  }
}

async function fetchVideoDirectUrl(
  ctx: Context,
  detail: BilibiliVideoDetail,
  bilibiliUrl: string,
  config: Config,
  logger: Logger
): Promise<string> {
  const officialUrl = await fetchVideoDirectUrlViaOfficialApi(ctx, detail, config, logger)
  if (officialUrl) {
    return officialUrl
  }

  const xingzhigeUrl = await fetchVideoDirectUrlViaXingzhige(ctx, bilibiliUrl, config, logger)
  if (xingzhigeUrl) {
    return xingzhigeUrl
  }

  const injahowUrl = await fetchVideoDirectUrlViaInjahow(ctx, detail, config, logger)
  if (injahowUrl) {
    return injahowUrl
  }

  return ''
}

async function fetchVideoDirectUrlViaOfficialApi(
  ctx: Context,
  detail: BilibiliVideoDetail,
  config: Config,
  logger: Logger
): Promise<string> {
  if (!detail.bvid || !detail.cid) {
    return ''
  }

  const endpoint = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(detail.bvid)}&cid=${encodeURIComponent(detail.cid)}&qn=80&fnval=0&fnver=0&fourk=1`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs)
    const code = toNumber(payload?.code)
    if (code !== 0 || !payload?.data) {
      const reason = typeof payload?.message === 'string' ? payload.message : `code=${code}`
      logger.debug(`bilibili official playurl unavailable: ${reason}`)
      return ''
    }

    const candidateUrls = collectPlayUrls(payload.data)
    for (const candidate of candidateUrls) {
      if (!isSafePublicHttpUrl(candidate)) {
        logger.warn(`bilibili official url blocked by url safety policy: ${candidate}`)
        continue
      }

      if (!isTrustedBilibiliVideoUrl(candidate)) {
        logger.warn(`bilibili official url blocked by host policy: ${candidate}`)
        continue
      }

      return candidate
    }

    return ''
  } catch (error) {
    logger.debug(`bilibili official playurl request failed: ${String((error as Error)?.message || error)}`)
    return ''
  }
}

async function fetchVideoDirectUrlViaXingzhige(
  ctx: Context,
  bilibiliUrl: string,
  config: Config,
  logger: Logger
): Promise<string> {
  const endpoint = `https://api.xingzhige.com/API/b_parse/?url=${encodeURIComponent(bilibiliUrl)}`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs)
    const code = toNumber(payload?.code)
    const videoUrl = asString(payload?.data?.video?.url).trim()

    if (code === 0 && videoUrl) {
      const normalized = normalizeResourceUrl(videoUrl)
      if (!isSafePublicHttpUrl(normalized)) {
        logger.warn(`bilibili direct video blocked by url safety policy: ${normalized}`)
        return ''
      }

      if (!isTrustedBilibiliVideoUrl(normalized)) {
        logger.warn(`bilibili direct video blocked by host policy: ${normalized}`)
        return ''
      }

      return normalized
    }

    const reason = typeof payload?.msg === 'string' ? payload.msg : `code=${code}`
    logger.debug(`bilibili xingzhige unavailable: ${reason}`)
    return ''
  } catch (error) {
    logger.debug(`bilibili xingzhige request failed: ${String((error as Error)?.message || error)}`)
    return ''
  }
}

async function fetchVideoDirectUrlViaInjahow(
  ctx: Context,
  detail: BilibiliVideoDetail,
  config: Config,
  logger: Logger
): Promise<string> {
  if (!detail.bvid && !detail.aid) {
    return ''
  }

  const query = detail.bvid
    ? `bv=${encodeURIComponent(detail.bvid)}`
    : `av=${encodeURIComponent(detail.aid)}`

  const endpoint = `https://api.injahow.cn/bparse/?${query}&p=1&q=64&format=mp4&otype=json`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs)
    const code = toNumber(payload?.code)
    const videoUrl = normalizeResourceUrl(asString(payload?.url).trim())

    if (code === 0 && videoUrl) {
      if (!isSafePublicHttpUrl(videoUrl)) {
        logger.warn(`bilibili injahow blocked by url safety policy: ${videoUrl}`)
        return ''
      }

      if (!isTrustedBilibiliVideoUrl(videoUrl)) {
        logger.warn(`bilibili injahow blocked by host policy: ${videoUrl}`)
        return ''
      }

      return videoUrl
    }

    const reason = typeof payload?.msg === 'string' ? payload.msg : `code=${code}`
    logger.debug(`bilibili injahow unavailable: ${reason}`)
    return ''
  } catch (error) {
    logger.debug(`bilibili injahow request failed: ${String((error as Error)?.message || error)}`)
    return ''
  }
}

function collectPlayUrls(data: any): string[] {
  const urls: string[] = []

  if (Array.isArray(data?.durl)) {
    for (const item of data.durl) {
      urls.push(normalizeResourceUrl(item?.url))
      if (Array.isArray(item?.backup_url)) {
        for (const backup of item.backup_url) {
          urls.push(normalizeResourceUrl(backup))
        }
      }
      if (Array.isArray(item?.backupUrl)) {
        for (const backup of item.backupUrl) {
          urls.push(normalizeResourceUrl(backup))
        }
      }
    }
  }

  if (Array.isArray(data?.dash?.video)) {
    for (const item of data.dash.video) {
      urls.push(normalizeResourceUrl(item?.base_url))
      urls.push(normalizeResourceUrl(item?.baseUrl))
      if (Array.isArray(item?.backup_url)) {
        for (const backup of item.backup_url) {
          urls.push(normalizeResourceUrl(backup))
        }
      }
      if (Array.isArray(item?.backupUrl)) {
        for (const backup of item.backupUrl) {
          urls.push(normalizeResourceUrl(backup))
        }
      }
    }
  }

  return Array.from(new Set(urls.filter(Boolean)))
}

function extractVideoId(input: string): BilibiliVideoId | null {
  if (!input) {
    return null
  }

  try {
    const parsed = new URL(input)
    const queryBvid = parsed.searchParams.get('bvid')
    if (queryBvid && BVID_RE.test(queryBvid)) {
      return {
        type: 'bv',
        value: normalizeBvid(queryBvid),
      }
    }

    const queryAid = parsed.searchParams.get('aid')
    if (queryAid && /^\d+$/.test(queryAid)) {
      return {
        type: 'av',
        value: queryAid,
      }
    }

    const path = decodeURIComponent(parsed.pathname || '')
    const pathBvid = path.match(/\/video\/(BV[0-9a-zA-Z]{10})/i)?.[1]
    if (pathBvid) {
      return {
        type: 'bv',
        value: normalizeBvid(pathBvid),
      }
    }

    const pathAvid = path.match(/\/video\/av(\d+)/i)?.[1]
    if (pathAvid) {
      return {
        type: 'av',
        value: pathAvid,
      }
    }
  } catch {
    // ignore URL parse errors and fallback to global pattern matching
  }

  const bvid = input.match(BVID_RE)?.[0]
  if (bvid) {
    return {
      type: 'bv',
      value: normalizeBvid(bvid),
    }
  }

  const avid = input.match(AVID_RE)?.[1]
  if (avid) {
    return {
      type: 'av',
      value: avid,
    }
  }

  return null
}

async function requestJson(
  ctx: Context,
  url: string,
  timeoutMs: number
): Promise<any> {
  const text = await requestText(ctx, url, timeoutMs, {
    referer: 'https://www.bilibili.com/',
    accept: 'application/json,text/plain,*/*',
  })

  if (!text || typeof text !== 'string') {
    throw new Error('empty response')
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid json response')
  }
}

function buildContent(detail: BilibiliVideoDetail, maxDescLength: number): string {
  const lines = [
    `播放: ${formatCount(detail.stats.view)} | 点赞: ${formatCount(detail.stats.like)} | 投币: ${formatCount(detail.stats.coin)}`,
    `收藏: ${formatCount(detail.stats.favorite)} | 转发: ${formatCount(detail.stats.share)} | 弹幕: ${formatCount(detail.stats.danmaku)}`,
  ]

  const description = truncate(detail.description, maxDescLength)
  if (description) {
    lines.push(`简介: ${description}`)
  }

  return lines.join('\n')
}

function truncate(input: string, maxLength: number): string {
  if (!input) {
    return ''
  }
  if (!maxLength || maxLength < 1 || input.length <= maxLength) {
    return input
  }
  return `${input.slice(0, maxLength)}...`
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }
  if (value >= 100_000_000) {
    return `${formatCompact(value / 100_000_000)}亿`
  }
  if (value >= 10_000) {
    return `${formatCompact(value / 10_000)}万`
  }
  return String(Math.floor(value))
}

function formatCompact(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

function normalizeResourceUrl(url: string): string {
  const value = asString(url).trim()
  if (!value) {
    return ''
  }
  if (value.startsWith('//')) {
    return `https:${value}`
  }
  return value
}

function normalizeBvid(value: string): string {
  const text = asString(value).trim()
  if (!text) {
    return ''
  }

  const exact = text.match(/^(?:bv|BV)([0-9a-zA-Z]{10})$/)
  if (exact) {
    return `BV${exact[1]}`
  }

  const partial = text.match(/(?:bv|BV)([0-9a-zA-Z]{10})/)
  if (partial) {
    return `BV${partial[1]}`
  }

  return text
}

function normalizeAid(value: unknown): string {
  const text = asString(value).trim()
  if (/^\d+$/.test(text)) {
    return text
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }

  return ''
}

function normalizeCid(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }

  const text = asString(value).trim()
  if (/^\d+$/.test(text)) {
    return text
  }

  return ''
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function isTrustedBilibiliVideoUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.includes('bilivideo.')
      || hostname === 'bilibili.com'
      || hostname.endsWith('.bilibili.com')
      || hostname === 'hdslb.com'
      || hostname.endsWith('.hdslb.com')
  } catch {
    return false
  }
}
