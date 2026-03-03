import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { requestText, resolveRedirect } from '../utils/http'
import { isSafePublicHttpUrl } from '../utils/url'

const TWEET_ID_RE = /(?:^|\/)status(?:es)?\/(\d{6,25})(?:$|[/?#])/i

export async function parseTwitter(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const key = config.twitter.rapidApiKey?.trim()
  const host = config.twitter.rapidApiHost?.trim()
  if (!key) {
    throw new Error('Twitter/X 解析失败：未配置 rapidApiKey')
  }
  if (!host) {
    throw new Error('Twitter/X 解析失败：未配置 rapidApiHost')
  }

  const endpointPath = normalizeEndpointPath(config.twitter.endpointPath || '/download')
  const finalUrl = await resolveRedirect(ctx, inputUrl, config.timeoutMs, logger)
  const tweetId = extractTweetId(finalUrl) || extractTweetId(inputUrl)
  const canonicalUrl = tweetId ? `https://x.com/i/status/${tweetId}` : finalUrl

  const payload = await fetchRapidApiPayload(
    ctx,
    host,
    endpointPath,
    canonicalUrl,
    key,
    config.timeoutMs
  )

  const root = pickPayloadRoot(payload)
  const videos = collectVideoUrls(root)
  const images = collectImageUrls(root).slice(0, Math.max(1, config.twitter.maxImages || 1))
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
    content,
    canonicalUrl
  )

  if (videos.length === 0 && images.length === 0) {
    const remoteError = pickString(
      payload?.message,
      payload?.error,
      payload?.detail?.message,
      root?.message,
      root?.error
    )
    throw new Error(`Twitter/X 解析失败：${remoteError || '未找到可用媒体资源'}`)
  }

  return {
    platform: 'twitter',
    title,
    content,
    images,
    videos,
    originalUrl: inputUrl,
    resolvedUrl: canonicalUrl,
  }
}

async function fetchRapidApiPayload(
  ctx: Context,
  host: string,
  endpointPath: string,
  tweetUrl: string,
  rapidApiKey: string,
  timeoutMs: number
): Promise<any> {
  const endpoint = `https://${host}${endpointPath}?url=${encodeURIComponent(tweetUrl)}`
  const text = await requestText(ctx, endpoint, timeoutMs, {
    accept: 'application/json,text/plain,*/*',
    'X-RapidAPI-Key': rapidApiKey,
    'X-RapidAPI-Host': host,
  })

  if (!text || typeof text !== 'string') {
    throw new Error('RapidAPI empty response')
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('RapidAPI invalid json response')
  }
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
    if (lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') || lower.includes('.webp') || lower.includes('pbs.twimg.com/media/')) {
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

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list))
}
