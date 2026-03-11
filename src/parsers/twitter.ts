import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent, TwitterProvider } from '../types'
import { requestText, resolveRedirect } from '../utils/http'
import { isSafePublicHttpUrl } from '../utils/url'

const TWEET_ID_RE = /(?:^|\/)status(?:es)?\/(\d{6,25})(?:$|[/?#])/i

type RapidApiResult = {
  title: string
  author: string
  content: string
  images: string[]
  videos: string[]
  remoteError: string
}

type GrokResult = {
  title: string
  author: string
  text: string
  images: string[]
  videos: string[]
}

export async function parseTwitter(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const finalUrl = await resolveRedirect(ctx, inputUrl, config.timeoutMs, logger)
  const tweetId = extractTweetId(finalUrl) || extractTweetId(inputUrl)
  const canonicalUrl = tweetId ? `https://x.com/i/status/${tweetId}` : finalUrl

  let rapidPromise: Promise<RapidApiResult | null> | null = null
  let grokPromise: Promise<GrokResult | null> | null = null

  const fetchRapid = async (): Promise<RapidApiResult | null> => {
    if (!rapidPromise) {
      rapidPromise = fetchRapidApiResult(ctx, canonicalUrl, config, logger)
    }
    return rapidPromise
  }

  const fetchGrok = async (): Promise<GrokResult | null> => {
    if (!grokPromise) {
      grokPromise = fetchGrokExtract(ctx, canonicalUrl, config, logger)
    }
    return grokPromise
  }

  const textOrder = parseProviderOrder(config.twitterRouting.textProviderOrder, ['grok', 'rapidapi'])
  const imageOrder = parseProviderOrder(config.twitterRouting.imageProviderOrder, ['grok', 'rapidapi'])
  const videoOrder = parseProviderOrder(config.twitterRouting.videoProviderOrder, ['rapidapi', 'grok'])
  const translationOrder = parseProviderOrder(config.twitterRouting.translationProviderOrder, ['grok', 'rapidapi'])

  const textResolved = await resolveTextByOrder(textOrder, fetchRapid, fetchGrok)
  const imagesResolved = await resolveImagesByOrder(imageOrder, fetchRapid, fetchGrok, config.twitter.maxImages)
  const videosResolved = await resolveVideosByOrder(videoOrder, fetchRapid, fetchGrok)

  const rapidSnapshot = await fetchRapid()
  const grokSnapshot = await fetchGrok()

  const title = pickString(
    textResolved.title,
    rapidSnapshot?.title,
    grokSnapshot?.title,
    textResolved.value,
    canonicalUrl
  )
  const author = pickString(
    textResolved.author,
    rapidSnapshot?.author,
    grokSnapshot?.author
  )

  let translatedContent = ''
  let translationProvider: TwitterProvider | undefined
  if (config.twitterTranslation.enabled && textResolved.value) {
    const translated = await resolveTranslationByOrder(
      translationOrder,
      textResolved.value,
      ctx,
      config,
      logger
    )
    translatedContent = translated.value
    translationProvider = translated.provider
  }

  const hasAnyContent = Boolean(textResolved.value || imagesResolved.value.length || videosResolved.value.length)
  if (!hasAnyContent) {
    const remoteError = pickString(rapidSnapshot?.remoteError)
    throw new Error(`Twitter/X 解析失败：${remoteError || '未提取到正文、图片或视频'}`)
  }

  return {
    platform: 'twitter',
    title,
    author: author || undefined,
    content: textResolved.value,
    translatedContent: translatedContent || undefined,
    images: imagesResolved.value,
    videos: videosResolved.value,
    textProvider: textResolved.provider,
    imageProvider: imagesResolved.provider,
    videoProvider: videosResolved.provider,
    translationProvider,
    originalUrl: inputUrl,
    resolvedUrl: canonicalUrl,
  }
}

async function resolveTextByOrder(
  order: TwitterProvider[],
  fetchRapid: () => Promise<RapidApiResult | null>,
  fetchGrok: () => Promise<GrokResult | null>
): Promise<{ value: string; provider?: TwitterProvider; title: string; author: string }> {
  for (const provider of order) {
    if (provider === 'grok') {
      const grok = await fetchGrok()
      const text = pickString(grok?.text)
      if (text) {
        return {
          value: text,
          provider,
          title: pickString(grok?.title),
          author: pickString(grok?.author),
        }
      }
      continue
    }

    const rapid = await fetchRapid()
    const text = pickString(rapid?.content)
    if (text) {
      return {
        value: text,
        provider,
        title: pickString(rapid?.title),
        author: pickString(rapid?.author),
      }
    }
  }

  return {
    value: '',
    title: '',
    author: '',
  }
}

async function resolveImagesByOrder(
  order: TwitterProvider[],
  fetchRapid: () => Promise<RapidApiResult | null>,
  fetchGrok: () => Promise<GrokResult | null>,
  maxImages: number
): Promise<{ value: string[]; provider?: TwitterProvider }> {
  const limit = Math.max(1, maxImages || 1)
  for (const provider of order) {
    if (provider === 'grok') {
      const grok = await fetchGrok()
      const images = dedupe(grok?.images || []).slice(0, limit)
      if (images.length) {
        return {
          value: images,
          provider,
        }
      }
      continue
    }

    const rapid = await fetchRapid()
    const images = dedupe(rapid?.images || []).slice(0, limit)
    if (images.length) {
      return {
        value: images,
        provider,
      }
    }
  }

  return {
    value: [],
  }
}

async function resolveVideosByOrder(
  order: TwitterProvider[],
  fetchRapid: () => Promise<RapidApiResult | null>,
  fetchGrok: () => Promise<GrokResult | null>
): Promise<{ value: string[]; provider?: TwitterProvider }> {
  for (const provider of order) {
    if (provider === 'grok') {
      const grok = await fetchGrok()
      const videos = dedupe(grok?.videos || [])
      if (videos.length) {
        return {
          value: videos,
          provider,
        }
      }
      continue
    }

    const rapid = await fetchRapid()
    const videos = dedupe(rapid?.videos || [])
    if (videos.length) {
      return {
        value: videos,
        provider,
      }
    }
  }

  return {
    value: [],
  }
}

async function resolveTranslationByOrder(
  order: TwitterProvider[],
  text: string,
  ctx: Context,
  config: Config,
  logger: Logger
): Promise<{ value: string; provider?: TwitterProvider }> {
  const maxChars = Math.max(80, config.twitterTranslation.maxChars || 1200)
  const input = text.length > maxChars ? text.slice(0, maxChars) : text

  for (const provider of order) {
    if (provider === 'grok') {
      const translated = await translateByGrok(ctx, input, config, logger)
      if (translated) {
        return {
          value: translated,
          provider,
        }
      }
      continue
    }
  }

  return {
    value: '',
  }
}

async function fetchRapidApiResult(
  ctx: Context,
  tweetUrl: string,
  config: Config,
  logger: Logger
): Promise<RapidApiResult | null> {
  const key = config.twitter.rapidApiKey?.trim()
  const host = config.twitter.rapidApiHost?.trim()
  if (!key || !host) {
    logger.debug('twitter rapidapi skipped: rapidApiKey/rapidApiHost missing')
    return null
  }

  const endpointPath = normalizeEndpointPath(config.twitter.endpointPath || '/download')
  const endpoint = `https://${host}${endpointPath}?url=${encodeURIComponent(tweetUrl)}`
  const text = await requestText(ctx, endpoint, config.timeoutMs, {
    accept: 'application/json,text/plain,*/*',
    'X-RapidAPI-Key': key,
    'X-RapidAPI-Host': host,
  }).catch((error) => {
    logger.warn(`twitter rapidapi request failed: ${String((error as Error)?.message || error)}`)
    return ''
  })

  if (!text || typeof text !== 'string') {
    return null
  }

  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    logger.warn('twitter rapidapi response is not valid json')
    return null
  }

  const root = pickPayloadRoot(payload)
  const videos = collectVideoUrls(root)
  const images = collectImageUrls(root)
  const content = pickString(
    root?.text,
    root?.full_text,
    root?.tweet_text,
    root?.description,
    root?.desc,
    root?.caption,
    payload?.text,
    payload?.full_text,
    payload?.description,
    payload?.desc
  )
  const title = pickString(
    root?.title,
    payload?.title,
    content
  )
  const author = pickString(
    root?.author?.name,
    root?.author_name,
    root?.username,
    payload?.author,
    payload?.author_name
  )
  const remoteError = pickString(
    payload?.message,
    payload?.error,
    payload?.detail?.message,
    root?.message,
    root?.error
  )

  return {
    title,
    author,
    content,
    images,
    videos,
    remoteError,
  }
}

async function fetchGrokExtract(
  ctx: Context,
  tweetUrl: string,
  config: Config,
  logger: Logger
): Promise<GrokResult | null> {
  if (!config.twitterGrok.enabled) {
    return null
  }

  const baseUrl = (config.twitterGrok.baseUrl || '').trim()
  const apiKey = (config.twitterGrok.apiKey || '').trim()
  const model = (config.twitterGrok.model || '').trim()
  if (!baseUrl || !apiKey || !model) {
    logger.debug('twitter grok skipped: baseUrl/apiKey/model missing')
    return null
  }

  const endpoint = normalizeOpenAIChatEndpoint(baseUrl)
  const prompt = [
    '请访问并提取这个 X(Twitter) 链接内容，仅输出 JSON。',
    '字段固定：title, author, text, images, videos。',
    'images/videos 必须为 URL 数组；没有则空数组。',
    `链接：${tweetUrl}`,
  ].join('\n')

  const payload = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  }

  const response = await callOpenAICompatible(ctx, endpoint, apiKey, payload, config.twitterGrok.timeoutMs)
    .catch((error) => {
      logger.warn(`twitter grok extract failed: ${String((error as Error)?.message || error)}`)
      return null
    })
  if (!response) {
    return null
  }

  const content = extractAssistantText(response)
  if (!content) {
    return null
  }

  const parsed = parseFirstJsonObject(content)
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('twitter grok extract invalid json output')
    return null
  }

  const title = pickString((parsed as any).title)
  const author = pickString((parsed as any).author)
  const text = pickString((parsed as any).text, (parsed as any).content)
  const images = normalizeUrlArray((parsed as any).images)
  const videos = normalizeUrlArray((parsed as any).videos)

  return {
    title,
    author,
    text,
    images,
    videos,
  }
}

async function translateByGrok(
  ctx: Context,
  text: string,
  config: Config,
  logger: Logger
): Promise<string> {
  if (!config.twitterGrok.enabled || !config.twitterTranslation.enabled) {
    return ''
  }

  const baseUrl = (config.twitterGrok.baseUrl || '').trim()
  const apiKey = (config.twitterGrok.apiKey || '').trim()
  const model = (config.twitterGrok.model || '').trim()
  if (!baseUrl || !apiKey || !model) {
    return ''
  }

  const endpoint = normalizeOpenAIChatEndpoint(baseUrl)
  const targetLanguage = (config.twitterTranslation.targetLanguage || 'zh-CN').trim() || 'zh-CN'
  const prompt = [
    `请将以下文本翻译为 ${targetLanguage}。`,
    '要求：忠实、简洁，不要添加额外解释。',
    '只返回翻译后的文本本身。',
    '',
    text,
  ].join('\n')

  const payload = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  }

  const response = await callOpenAICompatible(ctx, endpoint, apiKey, payload, config.twitterGrok.timeoutMs)
    .catch((error) => {
      logger.warn(`twitter grok translation failed: ${String((error as Error)?.message || error)}`)
      return null
    })
  if (!response) {
    return ''
  }

  return pickString(extractAssistantText(response))
}

async function callOpenAICompatible(
  ctx: Context,
  endpoint: string,
  apiKey: string,
  payload: Record<string, any>,
  timeoutMs: number
): Promise<any> {
  const raw = await (ctx as any).http.post(endpoint, payload, {
    timeout: timeoutMs,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
  })

  if (!raw) {
    throw new Error('empty response')
  }

  if (typeof raw === 'string') {
    return JSON.parse(raw)
  }

  return raw
}

function extractAssistantText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === 'string') {
          return item
        }
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')

    return text.trim()
  }

  return ''
}

function parseProviderOrder(value: string | undefined, fallback: TwitterProvider[]): TwitterProvider[] {
  const source = (value || '').trim()
  const providers = source
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is TwitterProvider => item === 'rapidapi' || item === 'grok')

  if (!providers.length) {
    return fallback
  }

  return dedupe(providers)
}

function pickPayloadRoot(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  return payload.data
    || payload.result
    || payload.response
    || payload.tweet
    || payload.media
    || payload
}

function collectVideoUrls(root: unknown): string[] {
  const urls: string[] = []

  const add = (value: unknown): void => {
    const normalized = normalizeUrl(value)
    if (!normalized) {
      return
    }
    if (!isSafePublicHttpUrl(normalized)) {
      return
    }
    const lower = normalized.toLowerCase()
    if (lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('video.twimg.com')) {
      urls.push(normalized)
    }
  }

  const addFromAny = (value: unknown): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        addFromAny(item)
      }
      return
    }

    if (typeof value === 'string') {
      add(value)
      return
    }

    if (typeof value !== 'object') {
      return
    }

    const data = value as Record<string, unknown>
    add(data.url)
    add(data.playback_url)
    add(data.playbackUrl)
    add(data.download_url)
    add(data.downloadUrl)
    add(data.video_url)
    add(data.videoUrl)
    add(data.media_url)
    add(data.mediaUrl)

    for (const nested of Object.values(data)) {
      if (nested && typeof nested === 'object') {
        addFromAny(nested)
      }
    }
  }

  addFromAny(root)
  return dedupe(urls)
}

function collectImageUrls(root: unknown): string[] {
  const urls: string[] = []

  const add = (value: unknown): void => {
    const normalized = normalizeUrl(value)
    if (!normalized) {
      return
    }
    if (!isSafePublicHttpUrl(normalized)) {
      return
    }
    const lower = normalized.toLowerCase()
    if (
      lower.includes('.jpg')
      || lower.includes('.jpeg')
      || lower.includes('.png')
      || lower.includes('.webp')
      || lower.includes('pbs.twimg.com/media/')
    ) {
      urls.push(normalized)
    }
  }

  const walk = (value: unknown): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item)
      }
      return
    }

    if (typeof value === 'string') {
      add(value)
      return
    }

    if (typeof value !== 'object') {
      return
    }

    const data = value as Record<string, unknown>
    add(data.url)
    add(data.image)
    add(data.image_url)
    add(data.imageUrl)
    add(data.media_url)
    add(data.mediaUrl)
    add(data.thumbnail)
    add(data.thumbnail_url)
    add(data.thumbnailUrl)

    for (const nested of Object.values(data)) {
      if (nested && typeof nested === 'object') {
        walk(nested)
      }
    }
  }

  walk(root)
  return dedupe(urls)
}

function normalizeUrl(value: unknown): string {
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

function normalizeUrlArray(value: unknown): string[] {
  const list: string[] = []
  if (!Array.isArray(value)) {
    return list
  }

  for (const item of value) {
    const normalized = normalizeUrl(item)
    if (!normalized || !isSafePublicHttpUrl(normalized)) {
      continue
    }
    list.push(normalized)
  }

  return dedupe(list)
}

function normalizeOpenAIChatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }

  if (trimmed.endsWith('/v1/chat/completions')) {
    return trimmed
  }

  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`
  }

  return `${trimmed}/v1/chat/completions`
}

function parseFirstJsonObject(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    // continue to extract braces
  }

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (codeFenceMatch?.[1]) {
    try {
      return JSON.parse(codeFenceMatch[1].trim())
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }

  const candidate = trimmed.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function extractTweetId(input: string): string {
  if (!input) {
    return ''
  }

  const match = input.match(TWEET_ID_RE)
  return match?.[1] || ''
}

function normalizeEndpointPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return '/download'
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
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

function dedupe<T>(list: T[]): T[] {
  return Array.from(new Set(list))
}
