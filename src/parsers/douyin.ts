import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { requestText, resolveRedirect } from '../utils/http'

interface DouyinVideoMedia {
  kind: 'video'
  title: string
  url: string
  musicUrl?: string
}

interface DouyinImageMedia {
  kind: 'images'
  title: string
  urls: string[]
  musicUrl?: string
}

type DouyinMedia = DouyinVideoMedia | DouyinImageMedia

const DOUYIN_ID_RE_LIST = [
  /\/video\/(\d+)/,
  /\/note\/(\d+)/,
  /\/share\/(?:video|note)\/(\d+)/,
  /[?&](?:aweme_id|modal_id|item_id)=(\d+)/,
]

export class DouyinSkipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DouyinSkipError'
  }
}

export async function parseDouyin(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const finalUrl = await resolveRedirect(ctx, inputUrl, config.timeoutMs, logger)

  if (config.douyin.parseMode === 'video-only' && !/\/video\/(\d+)/.test(finalUrl)) {
    throw new DouyinSkipError('当前仅支持抖音视频链接。')
  }

  const awemeId = extractAwemeId(finalUrl)
  if (!awemeId) {
    throw new Error('无法从抖音链接中提取作品 ID')
  }

  let media: DouyinMedia
  try {
    media = await fetchDouyinMedia(ctx, awemeId, config, logger)
  } catch (error) {
    if (config.douyin.puppeteerFallback && (ctx as any).puppeteer) {
      logger.info('抖音 API 解析失败，切换 Puppeteer 回退。')
      media = await fetchDouyinMediaViaPuppeteer(ctx, finalUrl, awemeId, config, logger)
    } else {
      throw error
    }
  }

  if (media.kind === 'video') {
    return {
      platform: 'douyin',
      title: media.title,
      content: '',
      images: [],
      videos: [media.url],
      musicUrl: media.musicUrl,
      originalUrl: inputUrl,
      resolvedUrl: finalUrl,
    }
  }

  return {
    platform: 'douyin',
    title: media.title,
    content: '',
    images: media.urls,
    videos: [],
    musicUrl: media.musicUrl,
    originalUrl: inputUrl,
    resolvedUrl: finalUrl,
  }
}

function extractAwemeId(url: string): string | null {
  for (const re of DOUYIN_ID_RE_LIST) {
    const match = re.exec(url)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function normalizePlayUrl(url: string): string {
  return url.replace('/playwm/', '/play/')
}

async function fetchDouyinMedia(
  ctx: Context,
  awemeId: string,
  config: Config,
  logger: Logger
): Promise<DouyinMedia> {
  const endpoints = [
    `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
    `https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}`,
    `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}`,
  ]

  let lastError: unknown

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(ctx, endpoint, config)
      const aweme = data?.item_list?.[0] || data?.aweme_detail
      if (!aweme) {
        throw new Error('aweme not found')
      }
      return pickMediaFromAweme(aweme, awemeId, config)
    } catch (error) {
      lastError = error
      logger.debug(`douyin endpoint failed: ${endpoint} ${String((error as Error)?.message || error)}`)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('抖音解析失败')
}

async function fetchJson(ctx: Context, url: string, config: Config): Promise<any> {
  const text = await requestText(ctx, url, config.timeoutMs, {
    referer: 'https://www.douyin.com/',
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

function pickMediaFromAweme(aweme: any, awemeId: string, config: Config): DouyinMedia {
  const title = (aweme?.desc || '').trim() || `douyin:${awemeId}`
  const musicUrl =
    aweme?.music?.play_url?.url_list?.[0]
    || aweme?.music?.playUrl?.url_list?.[0]
    || aweme?.music?.playUrl
    || aweme?.music?.play_url

  if (config.douyin.parseMode !== 'video-only') {
    const imagePost = aweme?.image_post_info?.images
    const images = Array.isArray(aweme?.images)
      ? aweme.images
      : Array.isArray(imagePost)
        ? imagePost
        : null

    if (images?.length) {
      const urls = images
        .map((item: any) => item?.url_list?.[0] || item?.display_image?.url_list?.[0])
        .filter(Boolean)
        .slice(0, config.douyin.maxImages)

      if (urls.length) {
        return {
          kind: 'images',
          title,
          urls,
          musicUrl: typeof musicUrl === 'string' ? musicUrl : undefined,
        }
      }
    }
  }

  const playUrl = aweme?.video?.play_addr?.url_list?.[0] || aweme?.video?.play_addr?.url_list?.[1]
  if (!playUrl) {
    throw new DouyinSkipError('该抖音链接不是视频作品（没有可用的视频地址）。')
  }

  return {
    kind: 'video',
    title,
    url: normalizePlayUrl(playUrl),
    musicUrl: typeof musicUrl === 'string' ? musicUrl : undefined,
  }
}

async function fetchDouyinMediaViaPuppeteer(
  ctx: Context,
  pageUrl: string,
  awemeId: string,
  config: Config,
  logger: Logger
): Promise<DouyinMedia> {
  const puppeteerService = (ctx as any).puppeteer
  if (!puppeteerService) {
    throw new Error('puppeteer service not available')
  }

  const page = await puppeteerService.page()
  const candidates: any[] = []

  const onResponse = async (response: any): Promise<void> => {
    try {
      const url = typeof response.url === 'function' ? response.url() : response.url
      if (!url || typeof url !== 'string') {
        return
      }

      if (!/(douyin\.com|iesdouyin\.com)/.test(url)) {
        return
      }

      if (!/(aweme|note|item|detail|feed|web\/api|api)/.test(url)) {
        return
      }

      const text = await response.text()
      if (!text) {
        return
      }

      const data = safeJsonParse(text)
      if (!data) {
        return
      }

      const aweme = data?.item_list?.[0] || data?.aweme_detail || findAweme(data, awemeId)
      if (aweme) {
        candidates.push(aweme)
      }
    } catch {
      // ignore network parsing errors
    }
  }

  page.on('response', onResponse)

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    await page.setExtraHTTPHeaders({
      referer: 'https://www.douyin.com/',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    })

    const aweme = await probeAwemeFromPage(page, pageUrl, awemeId, candidates, config.douyin.puppeteerTimeoutMs)
      || await probeAwemeFromPage(
        page,
        `https://www.iesdouyin.com/share/video/${awemeId}`,
        awemeId,
        candidates,
        config.douyin.puppeteerTimeoutMs
      )

    if (!aweme) {
      throw new Error('puppeteer: aweme not found')
    }

    return pickMediaFromAweme(aweme, awemeId, config)
  } catch (error) {
    logger.debug(`puppeteer fallback failed: ${String((error as Error)?.message || error)}`)
    throw error
  } finally {
    page.off('response', onResponse)
    try {
      await page.close()
    } catch {
      // noop
    }
  }
}

async function probeAwemeFromPage(
  page: any,
  targetUrl: string,
  awemeId: string,
  candidates: any[],
  timeoutMs: number
): Promise<any | null> {
  candidates.length = 0
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await sleep(4_000)

  const fromResponses = candidates.find((item) => String(item?.aweme_id || item?.awemeId || '') === String(awemeId)) || candidates[0]
  if (fromResponses) {
    return fromResponses
  }

  const html = await page.content()
  if (!html || typeof html !== 'string') {
    return null
  }

  const renderData = extractScriptText(html, 'RENDER_DATA')
  const sigiState = extractScriptText(html, 'SIGI_STATE')
  const nextData = extractScriptText(html, '__NEXT_DATA__')

  const states = [
    renderData ? decodeMaybeEncodedJson(renderData) : null,
    sigiState ? safeJsonParse(sigiState) : null,
    nextData ? safeJsonParse(nextData) : null,
  ].filter(Boolean)

  for (const state of states) {
    const found = findAweme(state, awemeId)
    if (found) {
      return found
    }
  }

  return null
}

function findAweme(root: any, awemeId: string): any | null {
  const target = String(awemeId)
  const visited = new Set<any>()
  const stack: any[] = [root]
  const idKeys = ['aweme_id', 'awemeId', 'id', 'item_id', 'itemId', 'note_id', 'noteId']

  let steps = 0
  while (stack.length) {
    const current = stack.pop()
    steps += 1
    if (steps > 1_000_000) {
      break
    }

    if (!current) {
      continue
    }

    if (typeof current === 'string') {
      const nested = decodeMaybeEncodedJson(current) || safeJsonParse(current)
      if (nested) {
        stack.push(nested)
      }
      continue
    }

    if (typeof current !== 'object') {
      continue
    }

    if (visited.has(current)) {
      continue
    }
    visited.add(current)

    for (const key of idKeys) {
      const value = (current as any)[key]
      if (value != null && String(value) === target) {
        return current
      }
    }

    const itemStruct = (current as any).itemStruct
    if (itemStruct?.video || itemStruct?.images || itemStruct?.image_post_info) {
      return itemStruct
    }

    const awemeDetail = (current as any).aweme_detail
    if (awemeDetail?.video || awemeDetail?.images || awemeDetail?.image_post_info) {
      return awemeDetail
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item)
      }
    } else {
      for (const value of Object.values(current)) {
        stack.push(value)
      }
    }
  }

  return null
}

function extractScriptText(html: string, id: string): string | null {
  const re = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i')
  const match = re.exec(html)
  return match?.[1] ?? null
}

function decodeMaybeEncodedJson(raw: string): any | null {
  const text = raw.trim()
  if (!text) {
    return null
  }

  const direct = safeJsonParse(text)
  if (direct) {
    return direct
  }

  if (!/%7B|%5B/i.test(text)) {
    return null
  }

  try {
    return safeJsonParse(decodeURIComponent(text))
  } catch {
    return null
  }
}

function safeJsonParse(text: string): any | null {
  const payload = text.trim()
  if (!payload) {
    return null
  }

  if (!(payload.startsWith('{') || payload.startsWith('['))) {
    return null
  }

  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
