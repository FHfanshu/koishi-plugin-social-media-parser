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

const IMAGE_SUFFIX_RE = /\.(?:png|jpe?g|webp|gif|bmp)(?:$|\?)/i
const AUDIO_SUFFIX_RE = /\.(?:mp3|m4a|aac|wav|flac|ogg|opus)(?:$|\?)/i

export async function parseDouyin(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const apiBaseUrl = normalizeApiBaseUrl(config.douyin.apiBaseUrl || 'https://api.douyin.wtf')
  const timeoutMs = Math.max(30_000, config.timeoutMs)
  const payloadSources: Array<{ source: 'hybrid' | 'rapidapi'; payload: any }> = []
  let lastError: Error | null = null

  try {
    const hybridPayload = await fetchHybridPayload(
      ctx,
      apiBaseUrl,
      config.douyin.fallbackApiBaseUrls,
      inputUrl,
      timeoutMs,
      logger,
      config.debug
    )
    payloadSources.push({ source: 'hybrid', payload: hybridPayload })
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error))
    if (config.debug) {
      logger.info(`douyin hybrid chain failed: ${lastError.message}`)
    }
  }

  try {
    const rapidPayload = await fetchRapidApiPayload(
      ctx,
      config,
      inputUrl,
      timeoutMs,
      logger,
      config.debug
    )
    if (rapidPayload) {
      payloadSources.push({ source: 'rapidapi', payload: rapidPayload })
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error))
    if (config.debug) {
      logger.info(`douyin rapidapi chain failed: ${lastError.message}`)
    }
  }

  for (const item of payloadSources) {
    try {
      const parsed = parseDouyinPayload(item.payload, inputUrl, config, logger)
      if (config.debug && item.source === 'rapidapi') {
        logger.info('douyin parsed via rapidapi fallback')
      }
      return parsed
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (config.debug) {
        logger.info(`douyin payload rejected from ${item.source}: ${lastError.message}`)
      }
    }
  }

  throw lastError || new Error('抖音解析失败：无可用数据源')
}

function parseDouyinPayload(payload: any, inputUrl: string, config: Config, logger: Logger): ParsedContent {
  const data = payload?.data ?? payload
  const code = toNumber(payload?.code)

  if (code >= 400) {
    const reason = extractRemoteError(payload)
    throw new Error(`抖音解析失败：${reason || `code=${code}`}`)
  }

  if (!data || typeof data !== 'object') {
    const reason = extractRemoteError(payload) || `code=${code}`
    throw new Error(`抖音解析失败：${reason}`)
  }

  const media = pickMediaFromHybrid(data, inputUrl, config, logger)
  const resolvedUrl = pickString(
    data?.aweme_detail?.share_url,
    data?.aweme_detail?.share_info?.share_url,
    data?.share_url,
    data?.url,
    inputUrl
  )

  if (media.kind === 'video') {
    return {
      platform: 'douyin',
      title: media.title,
      content: '',
      images: [],
      videos: [media.url],
      musicUrl: media.musicUrl,
      originalUrl: inputUrl,
      resolvedUrl,
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
    resolvedUrl,
  }
}

async function fetchHybridPayload(
  ctx: Context,
  apiBaseUrl: string,
  fallbackApiBaseUrls: string[] | undefined,
  inputUrl: string,
  timeoutMs: number,
  logger: Logger,
  debugEnabled: boolean
): Promise<any> {
  const apiBases = buildApiBaseCandidates(apiBaseUrl, fallbackApiBaseUrls)
  const urls = [inputUrl]

  let resolvedUrl = ''
  try {
    resolvedUrl = await resolveRedirect(ctx, inputUrl, Math.min(timeoutMs, 20_000), logger)
  } catch {
    resolvedUrl = ''
  }

  if (resolvedUrl && resolvedUrl !== inputUrl) {
    urls.push(resolvedUrl)
  }

  const attempts: Array<{ endpoint: string; minimal: boolean }> = []
  for (const base of apiBases) {
    for (const url of urls) {
      attempts.push({ endpoint: `${base}/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=false`, minimal: false })
      attempts.push({ endpoint: `${base}/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=true`, minimal: true })
    }
  }

  let lastError: Error | null = null
  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index]
    try {
      const payload = await fetchJson(ctx, current.endpoint, timeoutMs)
      const code = toNumber(payload?.code)

      if (code && code >= 400) {
        const reason = extractRemoteError(payload)
        if (debugEnabled) {
          logger.info(`douyin hybrid rejected (${code}): ${reason || 'unknown reason'}; endpoint=${current.endpoint}`)
        }
        lastError = new Error(reason || `code=${code}`)
        continue
      }

      return payload
    } catch (error) {
      const message = (error as Error)?.message || String(error)
      lastError = error instanceof Error ? error : new Error(message)
      if (debugEnabled) {
        logger.info(`douyin hybrid request failed: ${message}; endpoint=${current.endpoint}`)
      }

      if (index < attempts.length - 1) {
        await sleep(250)
      }
    }
  }

  throw lastError || new Error('抖音解析请求失败')
}

async function fetchRapidApiPayload(
  ctx: Context,
  config: Config,
  inputUrl: string,
  timeoutMs: number,
  logger: Logger,
  debugEnabled: boolean
): Promise<any | null> {
  const key = (config.douyin.rapidApiKey || '').trim()
  const host = (config.douyin.rapidApiHost || '').trim()
  if (!key || !host) {
    if (debugEnabled && (key || host)) {
      logger.info('douyin rapidapi skipped: both rapidApiKey and rapidApiHost are required')
    }
    return null
  }

  const endpointPath = normalizeEndpointPath(config.douyin.rapidApiEndpointPath || '/api/hybrid/video_data')
  const urlParamKey = normalizeQueryKey(config.douyin.rapidApiUrlParamKey || 'url')

  const candidates = [inputUrl]
  try {
    const resolved = await resolveRedirect(ctx, inputUrl, Math.min(timeoutMs, 20_000), logger)
    if (resolved && resolved !== inputUrl) {
      candidates.push(resolved)
    }
  } catch {}

  let lastError: Error | null = null
  for (let index = 0; index < candidates.length; index += 1) {
    const currentUrl = candidates[index]
    const endpoint = `https://${host}${endpointPath}?${urlParamKey}=${encodeURIComponent(currentUrl)}`
    try {
      const text = await requestText(ctx, endpoint, timeoutMs, {
        accept: 'application/json,text/plain,*/*',
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': host,
      })
      if (!text || typeof text !== 'string') {
        lastError = new Error('rapidapi empty response')
        continue
      }

      const payload = JSON.parse(text)
      if (toNumber(payload?.code) >= 400) {
        lastError = new Error(extractRemoteError(payload) || `code=${payload?.code}`)
        continue
      }

      return payload
    } catch (error) {
      const message = (error as Error)?.message || String(error)
      lastError = error instanceof Error ? error : new Error(message)
      if (debugEnabled) {
        logger.info(`douyin rapidapi request failed: ${message}; endpoint=${endpoint}`)
      }
    }
  }

  if (lastError) {
    throw lastError
  }
  return null
}

function pickMediaFromHybrid(root: any, inputUrl: string, config: Config, logger: Logger): DouyinMedia {
  const nodes = collectMediaNodes(root)
  let imageFallback: DouyinImageMedia | null = null

  for (const node of nodes) {
    const title = extractTitle(node, inputUrl)
    const musicUrl = extractMusicUrl(node)

    const videos = extractVideoUrls(node)
    if (videos.length > 0) {
      return {
        kind: 'video',
        title,
        url: videos[0],
        musicUrl,
      }
    }

    if (!imageFallback) {
      const images = extractImageUrls(node, config.douyin.maxImages)
      if (images.length > 0) {
        imageFallback = {
          kind: 'images',
          title,
          urls: images,
          musicUrl,
        }
      }
    }
  }

  if (imageFallback) {
    return imageFallback
  }

  if (config.debug) {
    logger.info(`douyin hybrid payload unsupported: ${JSON.stringify(trimForDebug(root))}`)
  }
  throw new Error('抖音解析失败：未找到可用的视频或图文资源')
}

function collectMediaNodes(root: unknown): any[] {
  if (!root || typeof root !== 'object') {
    return []
  }

  const nodes: any[] = []
  const queue: any[] = [root]
  const visited = new Set<any>()
  let steps = 0

  while (queue.length > 0) {
    const current = queue.shift()
    steps += 1
    if (steps > 20_000) {
      break
    }

    if (!current || typeof current !== 'object') {
      continue
    }

    if (visited.has(current)) {
      continue
    }
    visited.add(current)

    if (isMediaLikeNode(current)) {
      nodes.push(current)
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item)
      }
      continue
    }

    for (const value of Object.values(current)) {
      queue.push(value)
    }
  }

  if (nodes.length === 0 && typeof root === 'object') {
    nodes.push(root)
  }

  return nodes
}

function isMediaLikeNode(node: any): boolean {
  if (!node || typeof node !== 'object') {
    return false
  }

  return Boolean(
    node.video
    || node.images
    || node.image_post_info
    || node.imagePostInfo
    || node.photos
    || node.photo
    || node.aweme_detail
    || node.awemeDetail
  )
}

function extractVideoUrls(node: any): string[] {
  const urls: string[] = []

  const addUrl = (value: unknown): void => {
    const normalized = normalizeResourceUrl(value)
    if (!normalized || IMAGE_SUFFIX_RE.test(normalized) || !/^https?:\/\//i.test(normalized)) {
      return
    }

    if (!isLikelyVideoResourceUrl(normalized)) {
      return
    }

    urls.push(normalizePlayUrl(normalized))
  }

  const addUrlList = (value: unknown): void => {
    if (!Array.isArray(value)) {
      addUrl(value)
      return
    }

    for (const item of value) {
      addUrl(item)
    }
  }

  addUrlList(getPath(node, ['video', 'play_addr', 'url_list']))
  addUrlList(getPath(node, ['video', 'playAddr', 'url_list']))
  addUrlList(getPath(node, ['video', 'play_addr_h264', 'url_list']))
  addUrlList(getPath(node, ['video', 'playAddrH264', 'url_list']))
  addUrlList(getPath(node, ['video', 'download_addr', 'url_list']))
  addUrlList(getPath(node, ['video', 'downloadAddr', 'url_list']))
  addUrlList(getPath(node, ['video', 'url_list']))

  addUrl(node?.video_url)
  addUrl(node?.nwm_video_url)
  addUrl(node?.nwm_video_url_HQ)
  addUrl(node?.wm_video_url)
  addUrl(node?.play)
  addUrl(node?.play_url)
  addUrl(node?.url)
  addUrl(node?.download_url)
  addUrl(node?.downloadUrl)
  addUrl(node?.video)

  const bitRate = getPath(node, ['video', 'bit_rate'])
  if (Array.isArray(bitRate)) {
    for (const item of bitRate) {
      addUrlList(item?.play_addr?.url_list)
      addUrlList(item?.playAddr?.url_list)
      addUrlList(item?.play_addr_265?.url_list)
      addUrlList(item?.playAddr265?.url_list)
      addUrl(item?.url)
    }
  }

  const videoNode = node?.video
  if (videoNode && typeof videoNode === 'object') {
    for (const nestedUrl of collectHttpUrls(videoNode, 64)) {
      addUrl(nestedUrl)
    }
  }

  for (const nestedUrl of collectHttpUrls(node, 128)) {
    addUrl(nestedUrl)
  }

  return dedupe(urls)
}

function extractImageUrls(node: any, maxImages: number): string[] {
  const urls: string[] = []
  const add = (value: unknown): void => {
    const normalized = normalizeResourceUrl(value)
    if (normalized && /^https?:\/\//i.test(normalized)) {
      urls.push(normalized)
    }
  }

  const imageArrays = [
    node?.images,
    node?.image_post_info?.images,
    node?.imagePostInfo?.images,
    node?.image_post_info?.image_list,
    node?.photos,
  ]

  for (const list of imageArrays) {
    if (!Array.isArray(list)) {
      continue
    }

    for (const item of list) {
      if (typeof item === 'string') {
        add(item)
        continue
      }

      add(item?.url)
      add(item?.image_url)
      add(item?.display_image?.url_list?.[0])
      add(item?.origin_image?.url_list?.[0])
      add(item?.download_url?.url_list?.[0])
      add(item?.url_list?.[0])
    }
  }

  return dedupe(urls).slice(0, Math.max(1, maxImages || 1))
}

function extractTitle(node: any, inputUrl: string): string {
  return pickString(
    node?.desc,
    node?.title,
    node?.video_title,
    node?.aweme_detail?.desc,
    node?.aweme_detail?.title,
    inputUrl
  )
}

function extractMusicUrl(node: any): string | undefined {
  const value = pickString(
    node?.music?.play_url?.url_list?.[0],
    node?.music?.playUrl?.url_list?.[0],
    node?.music?.play_url,
    node?.music?.playUrl,
    node?.music_url,
    node?.audio?.url,
    node?.audio_url
  )

  return value || undefined
}

async function fetchJson(ctx: Context, url: string, timeoutMs: number): Promise<any> {
  const text = await requestText(ctx, url, timeoutMs, {
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

function collectHttpUrls(root: unknown, maxCount: number): string[] {
  if (!root || typeof root !== 'object') {
    return []
  }

  const urls: string[] = []
  const visited = new Set<unknown>()
  const stack: unknown[] = [root]
  let steps = 0

  while (stack.length > 0 && urls.length < maxCount) {
    const current = stack.pop()
    steps += 1
    if (steps > 10_000) {
      break
    }

    if (!current) {
      continue
    }

    if (typeof current === 'string') {
      if (/^https?:\/\//i.test(current)) {
        urls.push(current)
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

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item)
      }
      continue
    }

    for (const value of Object.values(current)) {
      stack.push(value)
    }
  }

  return dedupe(urls)
}

function getPath(source: any, path: Array<string | number>): unknown {
  let cursor = source
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') {
      return null
    }
    cursor = cursor[key as keyof typeof cursor]
  }

  return cursor
}

function normalizePlayUrl(url: string): string {
  return url.replace('/playwm/', '/play/')
}

function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return 'https://api.douyin.wtf'
  }

  return trimmed.replace(/\/+$/, '')
}

function buildApiBaseCandidates(primary: string, extras: string[] | undefined): string[] {
  const candidates = [primary, ...(extras || [])]

  if (primary.includes('api.douyin.wtf')) {
    candidates.push(primary.replace('api.douyin.wtf', 'douyin.wtf'))
  }

  if (primary.includes('douyin.wtf') && !primary.includes('api.douyin.wtf')) {
    candidates.push(primary.replace('douyin.wtf', 'api.douyin.wtf'))
  }

  return dedupe(candidates.map((item) => normalizeApiBaseUrl(item)))
}

function normalizeResourceUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  const text = value.trim()
  if (!text) {
    return ''
  }

  if (text.startsWith('//')) {
    return `https:${text}`
  }

  return text
}

function isLikelyVideoResourceUrl(url: string): boolean {
  const lower = url.toLowerCase()

  if (AUDIO_SUFFIX_RE.test(lower)) {
    return false
  }

  if (lower.includes('/ies-music/')) {
    return false
  }

  if (/(^|[?&])(?:mime_type|mimetype)=audio/i.test(lower)) {
    return false
  }

  if (/(^|[?&])(?:mime_type|mimetype)=video/i.test(lower)) {
    return true
  }

  if (/\.(?:mp4|webm|mov|m4v)(?:$|\?)/i.test(lower)) {
    return true
  }

  if (lower.includes('douyinvod.com') || lower.includes('/video/tos/')) {
    return true
  }

   if (
    lower.includes('/aweme/v1/play')
    || lower.includes('/aweme/v1/aweme/play')
    || lower.includes('amemv.com')
    || lower.includes('iesdouyin.com/aweme')
    || lower.includes('bytecdn')
    || lower.includes('ibytedtos')
    || lower.includes('byteimg.com')
    || lower.includes('video_id=')
  ) {
    return true
  }

  return false
}

function normalizeEndpointPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return '/api/hybrid/video_data'
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizeQueryKey(input: string): string {
  const trimmed = input.trim()
  return trimmed || 'url'
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }

    const trimmed = value.trim()
    if (trimmed) {
      return trimmed
    }
  }

  return ''
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list))
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function extractRemoteError(payload: any): string {
  const detailCode = toNumber(payload?.detail?.code)
  const message = pickString(
    payload?.message,
    payload?.detail?.message,
    payload?.detail,
    payload?.error,
    payload?.msg
  )

  if (detailCode > 0 && message) {
    return `${message} (detail.code=${detailCode})`
  }

  if (detailCode > 0) {
    return `detail.code=${detailCode}`
  }

  return message
}

function trimForDebug(value: unknown): unknown {
  if (value == null) {
    return value
  }

  try {
    const text = JSON.stringify(value)
    if (text.length <= 1000) {
      return value
    }

    return {
      preview: `${text.slice(0, 1000)}...`,
      size: text.length,
    }
  } catch {
    return '[unserializable]'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
