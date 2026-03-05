import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { isSafePublicHttpUrl } from '../utils/url'

export async function parseYouTube(
  ctx: Context,
  inputUrl: string,
  config: Config,
  _logger: Logger
): Promise<ParsedContent> {
  const key = config.youtube.rapidApiKey?.trim()
  const host = config.youtube.rapidApiHost?.trim()
  const endpointPath = normalizeEndpointPath(config.youtube.endpointPath || '/download')
  const urlParamKey = normalizeQueryKey(config.youtube.urlParamKey || 'url')

  if (!key) {
    throw new Error('YouTube 解析失败：未配置 rapidApiKey')
  }
  if (!host) {
    throw new Error('YouTube 解析失败：未配置 rapidApiHost')
  }

  const payload = await fetchSnapVideoPayload(ctx, {
    host,
    endpointPath,
    urlParamKey,
    inputUrl,
    rapidApiKey: key,
    timeoutMs: config.timeoutMs,
  })

  const root = pickPayloadRoot(payload)
  const videos = collectVideoUrls(root)
  const images = collectImageUrls(root).slice(0, Math.max(0, config.youtube.maxImages || 0))
  const title = pickString(root?.title, root?.description, payload?.title, inputUrl)
  const content = pickString(root?.description, root?.caption, root?.text)
  const durationText = pickString(root?.duration, payload?.duration)
  const videoDurationSec = parseDurationToSeconds(durationText)

  if (videos.length === 0 && images.length === 0) {
    throw new Error('YouTube 解析失败：未找到可用媒体资源')
  }

  return {
    platform: 'youtube',
    title,
    content,
    images,
    videos,
    videoDurationSec: videoDurationSec > 0 ? videoDurationSec : undefined,
    originalUrl: inputUrl,
    resolvedUrl: inputUrl,
  }
}

async function fetchSnapVideoPayload(
  ctx: Context,
  options: {
    host: string
    endpointPath: string
    urlParamKey: string
    inputUrl: string
    rapidApiKey: string
    timeoutMs: number
  }
): Promise<any> {
  const endpoint = `https://${options.host}${options.endpointPath}`
  const body = new URLSearchParams({
    [options.urlParamKey]: options.inputUrl,
  }).toString()

  const text = await ctx.http.post(endpoint, body, {
    timeout: options.timeoutMs,
    responseType: 'text',
    headers: {
      accept: 'application/json,text/plain,*/*',
      'content-type': 'application/x-www-form-urlencoded',
      'x-rapidapi-key': options.rapidApiKey,
      'x-rapidapi-host': options.host,
      'X-RapidAPI-Key': options.rapidApiKey,
      'X-RapidAPI-Host': options.host,
    },
  } as any)

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

  return payload.data || payload.result || payload.response || payload
}

function collectVideoUrls(root: any): string[] {
  const urls: string[] = []
  const add = (value: unknown): void => {
    const normalized = normalizeUrl(value)
    if (!normalized || !isSafePublicHttpUrl(normalized)) {
      return
    }

    const lower = normalized.toLowerCase()
    if (lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('googlevideo.com')) {
      urls.push(normalized)
    }
  }

  add(root?.url)
  add(root?.video)
  add(root?.videoUrl)
  add(root?.video_url)
  add(root?.downloadUrl)
  add(root?.download_url)

  const medias = root?.medias
  if (Array.isArray(medias)) {
    for (const media of medias) {
      add(media?.url)
      add(media?.videoUrl)
      add(media?.video_url)
    }
  }

  return dedupe(urls)
}

function collectImageUrls(root: any): string[] {
  const urls: string[] = []
  const add = (value: unknown): void => {
    const normalized = normalizeUrl(value)
    if (!normalized || !isSafePublicHttpUrl(normalized)) {
      return
    }

    const lower = normalized.toLowerCase()
    if (lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') || lower.includes('.webp') || lower.includes('ytimg.com')) {
      urls.push(normalized)
    }
  }

  add(root?.thumbnail)
  add(root?.thumbnailUrl)
  add(root?.thumbnail_url)
  add(root?.cover)

  return dedupe(urls)
}

function parseDurationToSeconds(value: string): number {
  const text = value.trim()
  if (!text) {
    return 0
  }

  if (/^\d+$/.test(text)) {
    return Number(text)
  }

  const parts = text.split(':').map((item) => Number(item.trim()))
  if (!parts.length || parts.some((item) => !Number.isFinite(item) || item < 0)) {
    return 0
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }

  return 0
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

function normalizeEndpointPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return '/download'
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
