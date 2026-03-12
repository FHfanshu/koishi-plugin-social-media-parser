import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent, TwitterProvider } from '../types'
import { requestText, resolveRedirect } from '../utils/http'
import { isSafePublicHttpUrl } from '../utils/url'

const TWEET_ID_RE = /(?:^|\/)status(?:es)?\/(\d{6,25})(?:$|[/?#])/i

type FxTwitterResult = {
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
  const finalUrl = await resolveRedirect(ctx, inputUrl, config.network.timeoutMs, logger)
  const tweetId = extractTweetId(finalUrl) || extractTweetId(inputUrl)
  const canonicalUrl = tweetId ? `https://x.com/i/status/${tweetId}` : finalUrl

  let fxPromise: Promise<FxTwitterResult | null> | null = null
  let grokPromise: Promise<GrokResult | null> | null = null

  const fetchFxTwitter = async (): Promise<FxTwitterResult | null> => {
    if (!fxPromise) {
      fxPromise = fetchFxTwitterResult(ctx, tweetId, config, logger)
    }
    return fxPromise
  }

  const fetchGrok = async (): Promise<GrokResult | null> => {
    if (!grokPromise) {
      grokPromise = fetchGrokExtract(ctx, canonicalUrl, config, logger)
    }
    return grokPromise
  }

  const textOrder = parseProviderOrder(config.platforms.twitter.routing.textProviderOrder, ['fxtwitter', 'grok'])
  const imageOrder = parseProviderOrder(config.platforms.twitter.routing.imageProviderOrder, ['fxtwitter', 'grok'])
  const videoOrder = parseProviderOrder(config.platforms.twitter.routing.videoProviderOrder, ['fxtwitter', 'grok'])
  const translationOrder = parseTranslationProviderOrder(
    config.platforms.twitter.routing.translationProviderOrder,
    ['grok']
  )

  const textResolved = await resolveTextByOrder(textOrder, fetchFxTwitter, fetchGrok)
  const imagesResolved = await resolveImagesByOrder(imageOrder, fetchFxTwitter, fetchGrok, config.platforms.twitter.maxImages)
  const videosResolved = await resolveVideosByOrder(videoOrder, fetchFxTwitter, fetchGrok)

  const fxSnapshot = await fetchFxTwitter()
  const grokSnapshot = await fetchGrok()

  const title = pickString(
    textResolved.title,
    fxSnapshot?.title,
    grokSnapshot?.title,
    textResolved.value,
    canonicalUrl
  )
  const author = pickString(
    textResolved.author,
    fxSnapshot?.author,
    grokSnapshot?.author
  )

  let content = textResolved.value
  let translatedContent = ''
  let translationProvider: TwitterProvider | undefined
  if (config.platforms.twitter.translation.enabled && textResolved.value) {
    const language = detectLanguage(textResolved.value)
    if (language !== 'zh') {
      const translated = await resolveTranslationByOrder(
        translationOrder,
        textResolved.value,
        ctx,
        config,
        logger
      )
      translatedContent = translated.value
      translationProvider = translated.provider

      if (language === 'other' && translatedContent) {
        content = ''
      }
    }
  }

  const hasAnyContent = Boolean(content || translatedContent || imagesResolved.value.length || videosResolved.value.length)
  if (!hasAnyContent) {
    const remoteError = pickString(fxSnapshot?.remoteError)
    throw new Error(`Twitter/X 解析失败：${remoteError || '未提取到正文、图片或视频'}`)
  }

  return {
    platform: 'twitter',
    title,
    author: author || undefined,
    content,
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
  fetchFxTwitter: () => Promise<FxTwitterResult | null>,
  fetchGrok: () => Promise<GrokResult | null>
): Promise<{ value: string; provider?: TwitterProvider; title: string; author: string }> {
  for (const provider of order) {
    if (provider === 'fxtwitter') {
      const fx = await fetchFxTwitter()
      const text = pickString(fx?.content)
      if (text) {
        return {
          value: text,
          provider,
          title: pickString(fx?.title),
          author: pickString(fx?.author),
        }
      }
      continue
    }

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
  fetchFxTwitter: () => Promise<FxTwitterResult | null>,
  fetchGrok: () => Promise<GrokResult | null>,
  maxImages: number
): Promise<{ value: string[]; provider?: TwitterProvider }> {
  const limit = Math.max(1, maxImages || 1)
  for (const provider of order) {
    if (provider === 'fxtwitter') {
      const fx = await fetchFxTwitter()
      const images = dedupe(fx?.images || []).slice(0, limit)
      if (images.length) {
        return {
          value: images,
          provider,
        }
      }
      continue
    }

    if (provider === 'grok') {
      const grok = await fetchGrok()
      const images = dedupe(grok?.images || []).slice(0, limit)
      if (images.length) {
        return {
          value: images,
          provider,
        }
      }
    }
  }

  return {
    value: [],
  }
}

async function resolveVideosByOrder(
  order: TwitterProvider[],
  fetchFxTwitter: () => Promise<FxTwitterResult | null>,
  fetchGrok: () => Promise<GrokResult | null>
): Promise<{ value: string[]; provider?: TwitterProvider }> {
  for (const provider of order) {
    if (provider === 'fxtwitter') {
      const fx = await fetchFxTwitter()
      const videos = dedupe(fx?.videos || [])
      if (videos.length) {
        return {
          value: videos,
          provider,
        }
      }
      continue
    }

    if (provider === 'grok') {
      const grok = await fetchGrok()
      const videos = dedupe(grok?.videos || [])
      if (videos.length) {
        return {
          value: videos,
          provider,
        }
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
  const maxChars = Math.max(80, config.platforms.twitter.translation.maxChars || 1200)
  const input = text.length > maxChars ? text.slice(0, maxChars) : text

  for (const provider of order) {
    if (provider !== 'grok') {
      continue
    }

    const translated = await translateByGrok(ctx, input, config, logger)
    if (translated) {
      return {
        value: translated,
        provider,
      }
    }
  }

  return {
    value: '',
  }
}

async function fetchFxTwitterResult(
  ctx: Context,
  tweetId: string,
  config: Config,
  logger: Logger
): Promise<FxTwitterResult | null> {
  if (!tweetId) {
    return null
  }

  const endpoint = `https://api.fxtwitter.com/status/${encodeURIComponent(tweetId)}`
  const text = await requestText(ctx, endpoint, config.network.timeoutMs, {
    accept: 'application/json,text/plain,*/*',
  }).catch((error) => {
    logger.warn(`twitter fxtwitter request failed: ${String((error as Error)?.message || error)}`)
    return ''
  })

  if (!text || typeof text !== 'string') {
    return null
  }

  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    logger.warn('twitter fxtwitter response is not valid json')
    return null
  }

  const root = pickFxPayloadRoot(payload)
  const content = pickString(
    root?.text,
    root?.full_text,
    root?.tweet_text,
    root?.description,
    payload?.text,
    payload?.full_text,
    payload?.tweet?.text,
    payload?.description
  )
  const author = pickString(
    root?.author?.name,
    root?.author?.screen_name,
    root?.author?.username,
    root?.author_name,
    payload?.author?.name,
    payload?.author_name,
    payload?.screen_name,
    payload?.username
  )
  const title = pickString(
    root?.title,
    payload?.title,
    content
  )
  const remoteError = pickString(
    payload?.error,
    payload?.message,
    payload?.detail?.message,
    root?.error,
    root?.message
  )

  const images = collectFxImageUrls(root)
  const videos = collectFxVideoUrls(root)

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
  if (!config.platforms.twitter.grok.enabled) {
    return null
  }

  const grokAccess = await resolveGrokAccess(ctx, config, logger)
  if (!grokAccess) {
    logger.debug('twitter grok skipped: endpoint/apiKey/model missing')
    return null
  }

  const prompt = [
    '请访问并提取这个 X(Twitter) 链接内容，仅输出 JSON。',
    '字段固定：title, author, text, images, videos。',
    'images/videos 必须为 URL 数组；没有则空数组。',
    `链接：${tweetUrl}`,
  ].join('\n')

  for (const model of grokAccess.modelCandidates) {
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

    const response = await callOpenAICompatible(
      ctx,
      grokAccess.endpoint,
      grokAccess.apiKey,
      payload,
      config.platforms.twitter.grok.timeoutMs
    ).catch((error) => {
      logger.warn(`twitter grok extract failed (model=${model}): ${formatHttpError(error)}`)
      return null
    })
    if (!response) {
      continue
    }

    const content = extractAssistantText(response)
    if (!content) {
      continue
    }

    const parsed = parseFirstJsonObject(content)
    if (!isRecord(parsed)) {
      logger.warn('twitter grok extract invalid json output')
      continue
    }

    const title = pickString(parsed.title)
    const author = pickString(parsed.author)
    const text = pickString(parsed.text, parsed.content)
    const images = normalizeUrlArray(parsed.images)
    const videos = normalizeUrlArray(parsed.videos)

    return {
      title,
      author,
      text,
      images,
      videos,
    }
  }

  return null
}

async function translateByGrok(
  ctx: Context,
  text: string,
  config: Config,
  logger: Logger
): Promise<string> {
  if (!config.platforms.twitter.grok.enabled || !config.platforms.twitter.translation.enabled) {
    return ''
  }

  const grokAccess = await resolveGrokAccess(ctx, config, logger)
  if (!grokAccess) {
    return ''
  }

  const targetLanguage = (config.platforms.twitter.translation.targetLanguage || 'zh-CN').trim() || 'zh-CN'
  const prompt = [
    `请将以下文本翻译为 ${targetLanguage}。`,
    '要求：忠实、简洁，不要添加额外解释。',
    '只返回翻译后的文本本身。',
    '',
    text,
  ].join('\n')

  for (const model of grokAccess.modelCandidates) {
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

    const response = await callOpenAICompatible(
      ctx,
      grokAccess.endpoint,
      grokAccess.apiKey,
      payload,
      config.platforms.twitter.grok.timeoutMs
    ).catch((error) => {
      logger.warn(`twitter grok translation failed (model=${model}): ${formatHttpError(error)}`)
      return null
    })
    if (!response) {
      continue
    }

    const translated = pickString(extractAssistantText(response))
    if (translated) {
      return translated
    }
  }

  return ''
}

async function resolveGrokAccess(
  ctx: Context,
  config: Config,
  logger: Logger
): Promise<{ endpoint: string; apiKey: string; modelCandidates: string[] } | null> {
  const model = (config.platforms.twitter.grok.model || '').trim()
  const directBaseUrl = pickString((config.platforms.twitter.grok as { baseUrl?: string }).baseUrl)
  const directApiKey = pickString((config.platforms.twitter.grok as { apiKey?: string }).apiKey)
  if (directBaseUrl && directApiKey) {
    const endpoint = normalizeOpenAIChatEndpoint(directBaseUrl)
    if (endpoint) {
      const modelCandidates = buildModelCandidates(model, true)
      if (!modelCandidates.length) {
        return null
      }
      return {
        endpoint,
        apiKey: directApiKey,
        modelCandidates,
      }
    }
  }

  const fromChatLuna = await resolveGrokAccessFromChatLuna(ctx, model, logger)
  if (fromChatLuna) {
    const modelCandidates = buildModelCandidates(model, true)
    if (!modelCandidates.length) {
      return null
    }
    return {
      endpoint: fromChatLuna.endpoint,
      apiKey: fromChatLuna.apiKey,
      modelCandidates,
    }
  }

  return null
}

async function resolveGrokAccessFromChatLuna(
  ctx: Context,
  model: string,
  logger: Logger
): Promise<{ endpoint: string; apiKey: string } | null> {
  const platform = extractModelPlatform(model)
  if (!platform) {
    return null
  }

  const chatluna = (ctx as Context & {
    chatluna?: {
      getPlugin?: (platformName: string) => unknown
    }
  }).chatluna
  if (!chatluna?.getPlugin) {
    return null
  }

  let plugin: unknown = null
  try {
    plugin = chatluna.getPlugin(platform)
  } catch {
    logger.debug(`twitter grok resolve platform failed: ${platform}`)
    return null
  }

  const config = isRecord(plugin) ? plugin.config : null
  const resolved = resolveEndpointAndApiKeyFromConfig(config)
  if (!resolved) {
    logger.debug(`twitter grok platform config missing endpoint/apiKey: ${platform}`)
    return null
  }

  return resolved
}

function resolveEndpointAndApiKeyFromConfig(
  config: unknown
): { endpoint: string; apiKey: string } | null {
  if (!isRecord(config)) {
    return null
  }

  const directApiKey = pickString(config.apiKey)
  const directBaseUrl = pickString(config.baseUrl, config.baseURL)
  if (directApiKey && directBaseUrl) {
    const endpoint = normalizeOpenAIChatEndpoint(directBaseUrl)
    if (endpoint) {
      return {
        endpoint,
        apiKey: directApiKey,
      }
    }
  }

  const apiKeys = config.apiKeys
  if (!Array.isArray(apiKeys)) {
    return null
  }

  for (const row of apiKeys) {
    if (Array.isArray(row)) {
      const candidateApiKey = pickString(row[0])
      const candidateBaseUrl = pickString(row[1])
      const enabled = row.length >= 3 ? row[2] !== false : true
      if (!enabled || !candidateApiKey || !candidateBaseUrl) {
        continue
      }

      const endpoint = normalizeOpenAIChatEndpoint(candidateBaseUrl)
      if (endpoint) {
        return {
          endpoint,
          apiKey: candidateApiKey,
        }
      }
      continue
    }

    if (!isRecord(row)) {
      continue
    }

    const candidateApiKey = pickString(row.apiKey, row.key)
    const candidateBaseUrl = pickString(row.baseUrl, row.baseURL, row.endpoint)
    const enabled = typeof row.enabled === 'boolean' ? row.enabled : true
    if (!enabled || !candidateApiKey || !candidateBaseUrl) {
      continue
    }

    const endpoint = normalizeOpenAIChatEndpoint(candidateBaseUrl)
    if (endpoint) {
      return {
        endpoint,
        apiKey: candidateApiKey,
      }
    }
  }

  return null
}

function extractModelPlatform(model: string): string {
  const source = (model || '').trim()
  if (!source) {
    return ''
  }

  const slashIndex = source.indexOf('/')
  if (slashIndex <= 0) {
    return ''
  }

  return source.slice(0, slashIndex).trim()
}

function buildModelCandidates(model: string, preferBareWhenNamespaced = false): string[] {
  const source = (model || '').trim()
  if (!source) {
    return []
  }

  const slashIndex = source.indexOf('/')
  if (slashIndex <= 0 || slashIndex >= source.length - 1) {
    return [source]
  }

  const bare = source.slice(slashIndex + 1).trim()
  return preferBareWhenNamespaced
    ? dedupe([bare, source].filter(Boolean))
    : dedupe([source, bare].filter(Boolean))
}

function formatHttpError(error: unknown): string {
  const base = String((error as Error)?.message || error)
  const response = (error as {
    response?: {
      status?: number
      data?: unknown
      body?: unknown
    }
  })?.response

  if (!response) {
    return base
  }

  const status = typeof response.status === 'number' ? ` [status=${response.status}]` : ''
  const payload = response.data ?? response.body
  let detail = ''
  if (typeof payload === 'string') {
    detail = payload.trim()
  } else if (payload != null) {
    try {
      detail = JSON.stringify(payload)
    } catch {
      detail = ''
    }
  }

  if (detail.length > 240) {
    detail = `${detail.slice(0, 240)}...`
  }

  return detail ? `${base}${status}: ${detail}` : `${base}${status}`
}

async function callOpenAICompatible(
  ctx: Context,
  endpoint: string,
  apiKey: string,
  payload: Record<string, any>,
  timeoutMs: number
): Promise<any> {
  const http = (ctx as Context & {
    http: {
      post: (url: string, body: Record<string, any>, options: {
        timeout: number
        headers: Record<string, string>
      }) => Promise<unknown>
    }
  }).http

  const raw = await http.post(endpoint, payload, {
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
    .filter((item): item is TwitterProvider => item === 'fxtwitter' || item === 'grok')

  if (!providers.length) {
    return fallback
  }

  return dedupe(providers)
}

function parseTranslationProviderOrder(value: string | undefined, fallback: Array<'grok'>): Array<'grok'> {
  const source = (value || '').trim()
  const providers = source
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is 'grok' => item === 'grok')

  if (!providers.length) {
    return fallback
  }

  return dedupe(providers)
}

function pickFxPayloadRoot(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  return payload.tweet
    || payload.data?.tweet
    || payload.data
    || payload.result
    || payload
}

function collectFxImageUrls(root: unknown): string[] {
  const urls: string[] = []

  const walk = (value: unknown, keyHint = ''): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, keyHint)
      }
      return
    }

    if (typeof value === 'string') {
      const photo = getBestPhotoUrl(value)
      if (photo && keyHint.toLowerCase().includes('profile') === false && keyHint.toLowerCase().includes('avatar') === false) {
        urls.push(photo)
      }
      return
    }

    if (typeof value !== 'object') {
      return
    }

    const key = keyHint.toLowerCase()
    const shouldTry = key.includes('photo')
      || key.includes('image')
      || key.includes('media')
      || key.includes('thumbnail')
      || getNodeType(value) === 'photo'

    if (shouldTry && !key.includes('profile') && !key.includes('avatar') && !key.includes('banner')) {
      const photo = getBestPhotoUrl(value)
      if (photo) {
        urls.push(photo)
      }
    }

    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      walk(nestedValue, nestedKey)
    }
  }

  walk(root)
  return dedupe(urls)
}

function collectFxVideoUrls(root: unknown): string[] {
  const urls: string[] = []

  const walk = (value: unknown, keyHint = ''): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, keyHint)
      }
      return
    }

    if (typeof value !== 'object') {
      if (typeof value === 'string') {
        const video = getBestVideoUrl(value)
        if (video) {
          urls.push(video)
        }
      }
      return
    }

    const key = keyHint.toLowerCase()
    const shouldTry = key.includes('video')
      || key.includes('variant')
      || key.includes('playback')
      || key.includes('media')
      || /video|animated_gif/i.test(getNodeType(value))

    if (shouldTry) {
      const video = getBestVideoUrl(value)
      if (video) {
        urls.push(video)
      }
    }

    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      walk(nestedValue, nestedKey)
    }
  }

  walk(root)
  return dedupe(urls)
}

function detectLanguage(text: string): 'zh' | 'en' | 'other' {
  const input = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/#\w+/g, '')
    .trim()

  if (!input) {
    return 'other'
  }

  const significant = input.match(/[\u3400-\u9fffA-Za-z]/g) || []
  if (!significant.length) {
    return 'other'
  }

  const zhCount = (input.match(/[\u3400-\u9fff]/g) || []).length
  const enCount = (input.match(/[A-Za-z]/g) || []).length
  const total = significant.length

  if (zhCount / total >= 0.2) {
    return 'zh'
  }

  if (enCount / total >= 0.4) {
    return 'en'
  }

  return 'other'
}

function getBestVideoUrl(value: unknown): string {
  const directFromString = normalizeVideoUrl(value)
  if (directFromString) {
    return directFromString
  }

  if (!value || typeof value !== 'object') {
    return ''
  }

  const node = value as Record<string, unknown>
  const variantSources: unknown[] = [
    node.variants,
    node.video_variants,
    node.videoVariants,
    getNestedRecord(node, 'video')?.variants,
    getNestedRecord(node, 'playback')?.variants,
  ]

  let bestUrl = ''
  let bestBitrate = -1
  for (const source of variantSources) {
    if (!Array.isArray(source)) {
      continue
    }

    for (const item of source) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const data = item as Record<string, unknown>
      const type = String(data.content_type || data.contentType || data.type || '').toLowerCase()
      if (type && !type.includes('mp4')) {
        continue
      }

      const url = normalizeVideoUrl(data.url || data.src || data.playback_url || data.playbackUrl)
      if (!url) {
        continue
      }

      const bitrateRaw = data.bitrate
      const bitrate = typeof bitrateRaw === 'number' ? bitrateRaw : Number(bitrateRaw || 0)
      if (!bestUrl || bitrate > bestBitrate) {
        bestUrl = url
        bestBitrate = bitrate
      }
    }
  }

  if (bestUrl) {
    return bestUrl
  }

  return pickString(
    normalizeVideoUrl(node.url),
    normalizeVideoUrl(node.video_url),
    normalizeVideoUrl(node.videoUrl),
    normalizeVideoUrl(node.playback_url),
    normalizeVideoUrl(node.playbackUrl),
    normalizeVideoUrl(node.download_url),
    normalizeVideoUrl(node.downloadUrl),
    normalizeVideoUrl(node.src),
    normalizeVideoUrl(getNestedRecord(node, 'video')?.url),
    normalizeVideoUrl(getNestedRecord(node, 'video')?.playback_url),
    normalizeVideoUrl(getNestedRecord(node, 'playback')?.url)
  )
}

function getBestPhotoUrl(value: unknown): string {
  const fromString = normalizePhotoUrl(value)
  if (fromString) {
    return fromString
  }

  if (!value || typeof value !== 'object') {
    return ''
  }

  const node = value as Record<string, unknown>
  return pickString(
    normalizePhotoUrl(node.url),
    normalizePhotoUrl(node.media_url),
    normalizePhotoUrl(node.mediaUrl),
    normalizePhotoUrl(node.image),
    normalizePhotoUrl(node.image_url),
    normalizePhotoUrl(node.imageUrl),
    normalizePhotoUrl(node.src),
    normalizePhotoUrl(node.thumbnail),
    normalizePhotoUrl(node.thumbnail_url),
    normalizePhotoUrl(node.thumbnailUrl)
  )
}

function normalizeVideoUrl(value: unknown): string {
  const normalized = normalizeUrl(value)
  if (!normalized || !isSafePublicHttpUrl(normalized)) {
    return ''
  }

  const lower = normalized.toLowerCase()
  if (
    lower.includes('.mp4')
    || lower.includes('.m3u8')
    || lower.includes('video.twimg.com')
    || lower.includes('twimg.com/ext_tw_video')
  ) {
    return normalized
  }

  return ''
}

function normalizePhotoUrl(value: unknown): string {
  const normalized = normalizeUrl(value)
  if (!normalized || !isSafePublicHttpUrl(normalized)) {
    return ''
  }

  const withQuality = ensurePbsOriginalQuality(normalized)
  const lower = withQuality.toLowerCase()
  if (
    lower.includes('.jpg')
    || lower.includes('.jpeg')
    || lower.includes('.png')
    || lower.includes('.webp')
    || lower.includes('pbs.twimg.com/media/')
  ) {
    return withQuality
  }

  return ''
}

function ensurePbsOriginalQuality(input: string): string {
  try {
    const parsed = new URL(input)
    if (!/pbs\.twimg\.com$/i.test(parsed.hostname)) {
      return input
    }

    if (!parsed.searchParams.has('name')) {
      parsed.searchParams.set('name', 'orig')
    }

    return parsed.toString()
  } catch {
    return input
  }
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

  const direct = parseJsonSafely(trimmed)
  if (direct) {
    return direct
  }

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (codeFenceMatch?.[1]) {
    const fromFence = parseJsonSafely(codeFenceMatch[1].trim())
    if (fromFence) {
      return fromFence
    }
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }

  const candidate = trimmed.slice(start, end + 1)
  return parseJsonSafely(candidate)
}

function parseJsonSafely(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function getNodeType(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return ''
  }

  return value.type.toLowerCase()
}

function getNestedRecord(node: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = node[key]
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function extractTweetId(input: string): string {
  if (!input) {
    return ''
  }

  const match = input.match(TWEET_ID_RE)
  return match?.[1] || ''
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
