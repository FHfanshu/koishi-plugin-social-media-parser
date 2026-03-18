import type { Context, Logger } from 'koishi'
import { load } from 'js-yaml'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { NetworkError, ParseError, RateLimitError, VerifyError, detectVerifyRequirement } from '../utils/errors'
import { requestText, resolveRedirect } from '../utils/http'
import { withRetry } from '../utils/retry'
import { normalizeInputUrl } from '../utils/url'

/**
 * Puppeteer service interface (partial)
 */
interface PuppeteerService {
  page?: () => Promise<PuppeteerPage>
}

interface PuppeteerPage {
  goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<void>
  content: () => Promise<string>
  close: () => Promise<void>
  waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<void>
  waitForTimeout: (ms: number) => Promise<void>
  setViewport: (viewport: { width: number; height: number }) => Promise<void>
  setUserAgent: (userAgent: string) => Promise<void>
  evaluate: (fn: () => void) => Promise<void>
  cookies: () => Promise<Array<{ name: string; value: string }>>
  setCookie: (...cookies: Array<{ name: string; value: string; domain?: string; path?: string }>) => Promise<void>
}

/**
 * Cache for xsec_token to reduce verification triggers.
 * Token is valid for a limited time and tied to a specific note.
 */
interface TokenCacheEntry {
  token: string
  expiresAt: number
}

const XSEC_TOKEN_CACHE = new Map<string, TokenCacheEntry>()
const TOKEN_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

// Modern browser headers to avoid detection
const XHS_BROWSER_HEADERS = {
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
} as const

/**
 * Parse cookie string into puppeteer cookie format.
 * Supports two formats:
 * - Single line with semicolon: "a1=xxx; web_session=xxx"
 * - Multiple lines (one per line): "a1=xxx\nweb_session=xxx"
 */
function parseCookieString(cookieStr: string): Array<{ name: string; value: string; domain: string }> {
  if (!cookieStr || !cookieStr.trim()) {
    return []
  }

  // Split by newline first, then by semicolon (handle both formats)
  const lines = cookieStr.split(/[\n;]/)

  return lines
    .map((line) => {
      const trimmed = line.trim()
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) {
        return null
      }
      const name = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (!name || !value) {
        return null
      }
      return { name, value, domain: '.xiaohongshu.com' }
    })
    .filter((c): c is { name: string; value: string; domain: string } => c !== null)
}

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
  const note = state ? extractNoteFromState(state) : null

  if (!state || !note) {
    // Debug: log why parsing failed
    const hasScript = html.includes('__INITIAL_STATE__')
    const hasCaptcha = html.includes('验证') || html.includes('captcha') || html.includes('slider')
    logger.warn(`xhs parse failed: hasState=${Boolean(state)}, hasNote=${Boolean(note)}, hasScript=${hasScript}, hasCaptcha=${hasCaptcha}, htmlLen=${html.length}`)
    throw new Error('提取小红书初始数据失败')
  }

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
    author,
    content,
    images,
    videos,
    videoDurationSec: undefined,
    originalUrl: inputUrl,
    resolvedUrl: canonicalUrl,
    extra: {
      noteId,
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

/**
 * Fetch HTML using browser (puppeteer) to bypass anti-bot verification.
 * This is more reliable but consumes more resources.
 */
async function fetchHtmlWithBrowser(
  ctx: Context,
  url: string,
  config: Config,
  logger: Logger
): Promise<string> {
  const puppeteer = (ctx as Context & { puppeteer?: PuppeteerService }).puppeteer
  if (!puppeteer || typeof puppeteer.page !== 'function') {
    throw new Error('Puppeteer 服务不可用，请确保已安装 koishi-plugin-puppeteer')
  }

  const timeout = config.platforms.xiaohongshu.browserTimeout
  const userAgent = config.platforms.xiaohongshu.userAgent
  logger.info(`xhs using browser mode, url=${url}, timeout=${timeout}`)

  const page = await puppeteer.page()
  if (!page) {
    throw new Error('无法创建 Puppeteer 页面')
  }

  try {
    // Set viewport to look like a real desktop browser
    await page.setViewport({ width: 1920, height: 1080 })

    // Set user agent
    await page.setUserAgent(userAgent)

    // Set cookies if configured (must be done before any page visits)
    const cookieStr = config.platforms.xiaohongshu.cookies
    if (cookieStr && cookieStr.trim()) {
      const cookies = parseCookieString(cookieStr)
      if (cookies.length > 0) {
        logger.info(`xhs browser: setting ${cookies.length} cookies`)
        await page.setCookie(...cookies)
      }
    }

    // Hide webdriver and automation flags
    try {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] } as any)
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
        // Hide Chrome automation flag
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).chrome = { runtime: {} }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const originalQuery = (window.navigator as any).permissions.query
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window.navigator as any).permissions.query = (parameters: any) =>
          parameters.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : originalQuery(parameters)
      })
    } catch (e) {
      logger.debug(`xhs browser mode: failed to inject stealth scripts: ${e}`)
    }

    // First visit homepage to establish session/cookies
    logger.debug('xhs browser: visiting homepage first')
    try {
      await page.goto('https://www.xiaohongshu.com', {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout, 15000),
      })
      // Random delay to simulate human behavior
      await sleep(500 + Math.random() * 500)
    } catch (e) {
      logger.debug(`xhs browser: homepage visit error (continuing): ${e}`)
    }

    // Now navigate to the target page
    logger.debug(`xhs browser: navigating to target URL`)
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    })

    // Wait for content to load
    try {
      await page.waitForSelector('script', { timeout: 5000 })
    } catch {
      // Continue even if selector not found
    }

    // Small delay to ensure JS execution
    await sleep(300)

    // Get the page content
    const html = await page.content()

    if (!html || typeof html !== 'string') {
      throw new NetworkError('xiaohongshu', '浏览器模式返回空页面')
    }

    // Check for verification requirement
    const verifyError = detectVerifyRequirement('xiaohongshu', html)
    if (verifyError) {
      if (!hasUsableNoteData(html)) {
        logger.warn(`xhs browser mode still hit verification: ${verifyError.verifyType}`)
        throw verifyError
      }
      logger.info('xhs browser mode: verify keyword detected but note data exists, continue parsing')
    }

    logger.info(`xhs browser mode success, htmlLen=${html.length}`)
    return html
  } finally {
    await page.close()
  }
}

async function fetchHtml(
  ctx: Context,
  url: string,
  config: Config,
  logger: Logger
): Promise<string> {
  // If browser mode is enabled and puppeteer is available, use it first
  if (config.platforms.xiaohongshu.useBrowser) {
    const puppeteer = (ctx as Context & { puppeteer?: PuppeteerService }).puppeteer
    if (puppeteer && typeof puppeteer.page === 'function') {
      try {
        return await fetchHtmlWithBrowser(ctx, url, config, logger)
      } catch (error) {
        // Log the error but don't throw yet - fall back to HTTP mode
        logger.warn(`xhs browser mode failed, falling back to HTTP: ${String((error as Error)?.message || error)}`)
      }
    } else {
      logger.warn('xhs browser mode enabled but puppeteer service not available, falling back to HTTP')
    }
  }

  // Extract note ID for token cache lookup
  const noteId = extractNoteId(url)

  // Check for cached token
  let cachedToken: string | undefined
  if (noteId) {
    const cached = XSEC_TOKEN_CACHE.get(noteId)
    if (cached && Date.now() < cached.expiresAt) {
      cachedToken = cached.token
    }
  }

  // Build URL with cached token if available
  let fetchUrl = url
  if (cachedToken) {
    try {
      const parsed = new URL(url)
      if (!parsed.searchParams.has('xsec_token')) {
        parsed.searchParams.set('xsec_token', cachedToken)
        parsed.searchParams.set('xsec_source', 'pc_user')
        fetchUrl = parsed.toString()
        logger.debug(`xhs using cached xsec_token for ${noteId}`)
      }
    } catch {
      // ignore URL parse errors
    }
  }

  // Complete browser headers including sec-ch-ua series
  const headers: Record<string, string> = {
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
    ...XHS_BROWSER_HEADERS,
  }

  const fetchPage = async (): Promise<string> => {
    const html = await requestText(ctx, fetchUrl, config.network.timeoutMs, headers)
    if (!html || typeof html !== 'string') {
      throw new NetworkError('xiaohongshu', '空页面响应')
    }

    // Check for verification requirement
    const verifyError = detectVerifyRequirement('xiaohongshu', html)
    if (verifyError) {
      if (!hasUsableNoteData(html)) {
        logger.warn(`xhs verification detected: ${verifyError.verifyType}`)
        throw verifyError
      }
      logger.info('xhs verification keyword detected but note data exists, continue parsing')
    }

    return html
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= config.platforms.xiaohongshu.maxRetries; attempt += 1) {
    try {
      const html = await fetchPage()

      // Try to cache xsec_token from response URL or content
      if (noteId) {
        cacheTokenFromHtml(noteId, html, logger)
      }

      return html
    } catch (error) {
      lastError = error
      const isVerifyError = error instanceof VerifyError

      // Don't retry on verification errors
      if (isVerifyError) {
        throw error
      }

      logger.info(`xhs fetch failed (${attempt}/${config.platforms.xiaohongshu.maxRetries}): ${String((error as Error)?.message || error)}`)

      if (attempt < config.platforms.xiaohongshu.maxRetries) {
        // Exponential backoff: 300ms, 600ms, 1200ms, ...
        const delay = attempt * 300 * Math.pow(1.5, attempt - 1)
        await sleep(delay)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new NetworkError('xiaohongshu', '抓取小红书页面失败')
}

/**
 * Extract and cache xsec_token from HTML content.
 */
function cacheTokenFromHtml(noteId: string, html: string, logger: Logger): void {
  try {
    // Try to extract token from __INITIAL_STATE__
    const match = html.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
    if (match) {
      const state = JSON.parse(match[1])
      const token = state?.note?.noteDetailMap?.['-1']?.note?.xsec_token
        || state?.noteData?.data?.noteData?.xsec_token

      if (token && typeof token === 'string') {
        XSEC_TOKEN_CACHE.set(noteId, {
          token,
          expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
        })
        logger.debug(`xhs cached xsec_token for ${noteId}`)
      }
    }
  } catch {
    // Ignore parse errors
  }
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

function hasUsableNoteData(html: string): boolean {
  const state = parseInitialState(html)
  if (!state) {
    return false
  }

  const note = extractNoteFromState(state)
  return Boolean(note)
}

function extractNoteFromState(state: Record<string, any>): Record<string, any> | null {
  const noteData = deepGet(state, ['noteData', 'data', 'noteData'])
  if (noteData && typeof noteData === 'object') {
    return noteData as Record<string, any>
  }

  const noteDetailMap = deepGet(state, ['note', 'noteDetailMap'])
  if (noteDetailMap && typeof noteDetailMap === 'object') {
    const map = noteDetailMap as Record<string, unknown>

    const preferred = map['-1']
    if (preferred && typeof preferred === 'object') {
      const note = deepGet(preferred, ['note'])
      if (note && typeof note === 'object') {
        return note as Record<string, any>
      }
    }

    for (const entry of Object.values(map)) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const note = deepGet(entry, ['note'])
      if (note && typeof note === 'object') {
        return note as Record<string, any>
      }
    }
  }

  return null
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
