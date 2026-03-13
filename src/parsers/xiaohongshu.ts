import type { Context, Logger } from 'koishi'
import { load } from 'js-yaml'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { requestText, resolveRedirect } from '../utils/http'
import { normalizeInputUrl } from '../utils/url'

export async function parseXiaohongshu(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const normalized = normalizeInputUrl(inputUrl)
  if (!normalized) {
    throw new Error('小红书链接无效或域名不受支持')
  }

  const finalUrl = await resolveRedirect(ctx, normalized, config.network.timeoutMs, logger)
  const canonicalUrl = toCanonicalXiaohongshuUrl(finalUrl)
  logger.info(`xhs canonical url: ${canonicalUrl}`)
  const html = await fetchHtml(ctx, canonicalUrl, config, logger)
  const state = parseInitialState(html)

  if (!state) {
    // Debug: log why parsing failed
    const hasScript = html.includes('__INITIAL_STATE__')
    const hasCaptcha = html.includes('验证') || html.includes('captcha') || html.includes('slider')
    logger.warn(`xhs parse failed: hasScript=${hasScript}, hasCaptcha=${hasCaptcha}, htmlLen=${html.length}`)
    throw new Error('提取小红书初始数据失败')
  }

  // Extract note data using the same path as chatluna-social-media-reader
  const note = deepGet(state, ['noteData', 'data', 'noteData'])
    || deepGet(state, ['note', 'noteDetailMap', '[-1]', 'note'])
    || {}

  const title = String(deepGet(note, ['title']) || '未命名笔记')
  const content = String(deepGet(note, ['desc']) || '')
  const images = extractImages(note, config.platforms.xiaohongshu.maxImages)
  const videos = extractVideos(note)
  const noteId = extractNoteId(canonicalUrl)
  const author = extractAuthor(note)
  const noteType = extractNoteType(note)
  const stats = extractStats(note)

  logger.info(`xhs parsed: title=${title}, images=${images.length}, videos=${videos.length}`)

  return {
    platform: 'xiaohongshu',
    title,
    content,
    images,
    videos,
    videoDurationSec: undefined,
    originalUrl: inputUrl,
    resolvedUrl: canonicalUrl,
    extra: {
      noteId,
      author,
      type: noteType,
      stats,
    },
  }
}

function toCanonicalXiaohongshuUrl(input: string): string {
  try {
    // Clean corrupted URL from QQ share (e.g., xhsshare=QQ%22,%22preview%22:...)
    let cleanInput = input
    const corruptedIdx = cleanInput.indexOf('%22,%22')
    if (corruptedIdx > 0) {
      cleanInput = cleanInput.slice(0, corruptedIdx)
    }

    const url = new URL(cleanInput)
    const match = url.pathname.match(/\/(?:discovery\/item|explore|item|note)\/([0-9a-zA-Z]+)/)
    if (!match?.[1]) {
      return cleanInput
    }

    const token = url.searchParams.get('xsec_token') || ''
    const canonical = new URL(`https://www.xiaohongshu.com/discovery/item/${match[1]}`)
    if (token) {
      canonical.searchParams.set('xsec_token', token)
      canonical.searchParams.set('xsec_source', 'pc_user')
    }
    return canonical.toString()
  } catch {
    return input
  }
}

async function fetchHtml(
  ctx: Context,
  url: string,
  config: Config,
  logger: Logger
): Promise<string> {
  // More complete browser headers to avoid detection
  const headers = {
    'user-agent': config.platforms.xiaohongshu.userAgent,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'referer': 'https://www.xiaohongshu.com/',
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= config.platforms.xiaohongshu.maxRetries; attempt += 1) {
    try {
      const html = await requestText(ctx, url, config.network.timeoutMs, headers)
      if (!html || typeof html !== 'string') {
        throw new Error('空页面响应')
      }
      return html
    } catch (error) {
      lastError = error
      logger.info(`xhs fetch failed (${attempt}/${config.platforms.xiaohongshu.maxRetries}): ${String((error as Error)?.message || error)}`)
      if (attempt < config.platforms.xiaohongshu.maxRetries) {
        await sleep(attempt * 300)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('抓取小红书页面失败')
}

function parseInitialState(html: string): Record<string, any> | null {
  // Extract all script tags and find the one with __INITIAL_STATE__
  const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)
  const scripts = Array.from(scriptMatches, (m) => (m[1] || '').trim()).reverse()

  const script = scripts.find((item) => item.startsWith('window.__INITIAL_STATE__'))
  if (!script) {
    return null
  }

  const text = script.replace(/^window\.__INITIAL_STATE__\s*=\s*/, '')

  // Use js-yaml load() which is more tolerant of non-standard JSON
  // (unquoted keys, undefined, NaN, etc.)
  try {
    const result = load(text)
    if (result && typeof result === 'object') {
      return result as Record<string, any>
    }
    return null
  } catch {
    return null
  }
}

function deepGet(data: unknown, keys: string[]): unknown {
  let value = data
  for (const key of keys) {
    if (value == null) {
      return null
    }

    // Handle array index notation like "[-1]"
    if (key.startsWith('[') && key.endsWith(']')) {
      const idx = Number(key.slice(1, -1))
      if (Number.isNaN(idx)) {
        return null
      }

      if (Array.isArray(value)) {
        value = value.at(idx)
        continue
      }

      if (typeof value === 'object') {
        const arr = Object.values(value as Record<string, unknown>)
        value = arr.at(idx)
        continue
      }

      return null
    }

    if (typeof value !== 'object') {
      return null
    }

    value = (value as Record<string, unknown>)[key]
  }

  return value
}

function extractImages(note: unknown, maxImages: number): string[] {
  const list = deepGet(note, ['imageList'])
  if (!Array.isArray(list)) {
    return []
  }

  const results: string[] = []
  for (const item of list) {
    // Try original URL first (has full path with date/hash which might work better)
    const originalUrl = String(deepGet(item, ['urlDefault']) || deepGet(item, ['url']) || '')
    if (!originalUrl) {
      continue
    }

    // Use original URL format (may include date/hash path and quality suffix)
    const formattedOriginal = formatUrl(originalUrl)
    if (formattedOriginal.startsWith('http')) {
      results.push(formattedOriginal)
      continue
    }

    // Fallback: extract token and construct CDN URL
    const token = getImageToken(originalUrl)
    if (token) {
      results.push(`https://sns-img-bd.xhscdn.com/${token}`)
    }
  }

  return dedupe(results).slice(0, maxImages)
}

function getImageToken(url: string): string {
  const text = formatUrl(url)
  const parts = text.split('/').slice(5)
  if (!parts.length) {
    return ''
  }

  const token = parts.join('/').split('!')[0]
  return token || ''
}

function extractVideos(note: unknown): string[] {
  // Primary: use originVideoKey
  const key = String(deepGet(note, ['video', 'consumer', 'originVideoKey']) || '')
  if (key) {
    return [`https://sns-video-bd.xhscdn.com/${key}`]
  }

  // Fallback: extract from h264/h265 streams
  const h264 = deepGet(note, ['video', 'media', 'stream', 'h264'])
  const h265 = deepGet(note, ['video', 'media', 'stream', 'h265'])
  const streams = [
    ...(Array.isArray(h264) ? h264 : []),
    ...(Array.isArray(h265) ? h265 : []),
  ]

  if (!streams.length) {
    return []
  }

  // Sort by quality (height first, then bitrate)
  streams.sort((a: any, b: any) => {
    const ah = Number(a.height || 0)
    const bh = Number(b.height || 0)
    if (ah !== bh) {
      return ah - bh
    }
    const ab = Number(a.videoBitrate || 0)
    const bb = Number(b.videoBitrate || 0)
    return ab - bb
  })

  const best = streams[streams.length - 1]
  if (!best) {
    return []
  }

  // Try backupUrls first, then masterUrl
  const backups = deepGet(best, ['backupUrls'])
  if (Array.isArray(backups) && backups[0]) {
    return [formatUrl(String(backups[0]))]
  }

  const master = String(deepGet(best, ['masterUrl']) || '')
  if (master) {
    return [formatUrl(master)]
  }

  return []
}

function formatUrl(url: string): string {
  return url.replace(/\\\//g, '/').replace(/&amp;/g, '&')
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractNoteId(url: string): string {
  try {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/\/(?:discovery\/item|explore|item|note)\/([0-9a-zA-Z]+)/)
    return match?.[1] || ''
  } catch {
    return ''
  }
}

function extractAuthor(note: unknown): string | undefined {
  const name = String(
    deepGet(note, ['user', 'nickname'])
    || deepGet(note, ['user', 'name'])
    || deepGet(note, ['author', 'nickname'])
    || ''
  )
  return name || undefined
}

function extractNoteType(note: unknown): 'video' | 'image' | undefined {
  const videoKey = deepGet(note, ['video', 'consumer', 'originVideoKey'])
  const hasVideo = Boolean(videoKey || deepGet(note, ['video', 'media', 'stream']))
  if (hasVideo) return 'video'
  const imageList = deepGet(note, ['imageList'])
  if (Array.isArray(imageList) && imageList.length > 0) return 'image'
  return undefined
}

function extractStats(note: unknown): { like: number; comment: number; collect: number; share: number } | undefined {
  const interactInfo = deepGet(note, ['interactInfo'])
  if (!interactInfo) return undefined
  const info = interactInfo as Record<string, unknown>
  return {
    like: toNumber(info.likedCount || info.likeCount),
    comment: toNumber(info.commentCount),
    collect: toNumber(info.collectedCount || info.collectCount),
    share: toNumber(info.shareCount),
  }
}

function toNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}