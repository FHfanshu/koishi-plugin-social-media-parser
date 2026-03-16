import type { ReadableStream } from 'node:stream/web'

import type { Context, Logger } from 'koishi'

import { isSafePublicHttpUrl } from './url'

export interface DownloadedBuffer {
  buffer: Buffer
  mimeType: string
  url: string
}

export interface DownloadOptions {
  headers?: Record<string, string>
  maxBytes?: number
  allowPrivate?: boolean
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
// Trusted public media CDN hosts that bypass Koishi's isLocal check
// These are known CDN domains that may resolve to various IPs but are safe public resources
const TRUSTED_PUBLIC_MEDIA_HOST_RE = /(^|\.)(xhscdn\.com|sns-webvideo-qc\.xhscdn\.com|sns-bak-.*\.xhscdn\.com|bilivideo\.cn|bilivideo\.com|.*\.bilivideo\.cn|.*\.bilivideo\.com|.*\.mcdn\.bilivideo\.cn|douyinvod\.com|.*\.douyinvod\.com|iesdouyin\.com|.*\.iesdouyin\.com|v\.douyin\.com|twimg\.com|x\.com|twitter\.com|t\.co)$/i

export async function resolveRedirect(
  ctx: Context,
  url: string,
  timeoutMs: number,
  logger?: Logger
): Promise<string> {
  let current = url
  for (let i = 0; i < 6; i += 1) {
    await assertSafeExternalUrl(ctx, current, false)

    const response = await (ctx as any).http(current, {
      method: 'GET',
      timeout: timeoutMs,
      redirect: 'manual',
      validateStatus: (status: number) => status >= 200 && status < 400,
      headers: {
        'user-agent': DEFAULT_UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })

    const status = response.status
    const location = response.headers?.get?.('location')

    if (status >= 300 && status < 400 && location) {
      let next = location
      try {
        next = new URL(location, response.url || current).toString()
      } catch {
        next = location
      }

      await assertSafeExternalUrl(ctx, next, false)
      current = next
      continue
    }

    if (typeof response.url === 'string' && response.url) {
      await assertSafeExternalUrl(ctx, response.url, false)
      current = response.url
    }
    break
  }

  logger?.debug?.(`redirect resolved: ${url} -> ${current}`)
  return current
}

export async function downloadBuffer(
  ctx: Context,
  url: string,
  timeoutMs: number,
  optionsOrHeaders?: DownloadOptions | Record<string, string>
): Promise<DownloadedBuffer> {
  const options = normalizeDownloadOptions(optionsOrHeaders)
  const headers = {
    'user-agent': DEFAULT_UA,
    ...(options.headers || {}),
  }

  await assertSafeExternalUrl(ctx, url, Boolean(options.allowPrivate))

  const response = await ctx.http(url, {
    method: 'GET',
    timeout: timeoutMs,
    redirect: 'follow',
    responseType: 'stream',
    validateStatus: (status: number) => status >= 200 && status < 400,
    headers,
  } as any)

  const finalUrl = typeof response.url === 'string' && response.url ? response.url : url
  await assertSafeExternalUrl(ctx, finalUrl, Boolean(options.allowPrivate))

  const contentLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10)
  if (options.maxBytes && Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    throw new Error(`media too large by header: ${contentLength} > ${options.maxBytes}`)
  }

  const stream = response.data as ReadableStream<Uint8Array> | undefined
  if (stream && typeof (stream as any).getReader === 'function') {
    const buffer = await readStreamWithLimit(stream, options.maxBytes)
    const mimeType = normalizeMimeType(response.headers?.get?.('content-type') || '') || guessMimeFromUrl(finalUrl)
    return {
      buffer,
      mimeType,
      url: finalUrl,
    }
  }

  const file = await ctx.http.file(finalUrl, {
    timeout: timeoutMs,
    headers,
  } as any)

  const buffer = Buffer.from(file.data)
  if (options.maxBytes && buffer.length > options.maxBytes) {
    throw new Error(`media too large: ${buffer.length} > ${options.maxBytes}`)
  }

  const mimeType = normalizeMimeType((file as any).type || (file as any).mime || '') || guessMimeFromUrl(finalUrl)
  return {
    buffer,
    mimeType,
    url: finalUrl,
  }
}

export async function requestText(
  ctx: Context,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<string> {
  await assertSafeExternalUrl(ctx, url, false)

  const response = await (ctx as any).http(url, {
    method: 'GET',
    timeout: timeoutMs,
    responseType: 'text',
    redirect: 'follow',
    validateStatus: (status: number) => status >= 200 && status < 400,
    headers: {
      'user-agent': DEFAULT_UA,
      ...headers,
    },
  })

  const finalUrl = typeof response?.url === 'string' && response.url ? response.url : url
  await assertSafeExternalUrl(ctx, finalUrl, false)

  const data = response?.data
  if (typeof data === 'string') {
    return data
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8')
  }

  return typeof data === 'undefined' || data === null ? '' : String(data)
}

export function guessMimeFromUrl(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes('.png')) return 'image/png'
  if (lower.includes('.webp')) return 'image/webp'
  if (lower.includes('.gif')) return 'image/gif'
  if (lower.includes('.jpeg') || lower.includes('.jpg')) return 'image/jpeg'
  if (lower.includes('.mp4')) return 'video/mp4'
  if (lower.includes('.webm')) return 'video/webm'
  if (lower.includes('.mov')) return 'video/mov'
  if (lower.includes('.m4a')) return 'audio/mp4'
  if (lower.includes('.m4s')) return 'video/mp4' // B站 DASH 视频流
  if (lower.includes('.mp3')) return 'audio/mpeg'
  if (lower.includes('.aac')) return 'audio/aac'
  return 'application/octet-stream'
}

export function normalizeMimeType(mimeType: string): string {
  if (!mimeType || typeof mimeType !== 'string') {
    return ''
  }

  const lower = mimeType.toLowerCase().trim()
  const [mainType] = lower.split(';')
  return mainType || ''
}

export function extensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'video/mp4':
      return '.mp4'
    case 'video/webm':
      return '.webm'
    case 'video/mov':
      return '.mov'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/mp4':
      return '.m4a'
    case 'audio/aac':
      return '.aac'
    default:
      // For video/* types, default to .mp4
      if (mimeType.startsWith('video/')) {
        return '.mp4'
      }
      // For audio/* types, default to .m4a
      if (mimeType.startsWith('audio/')) {
        return '.m4a'
      }
      return '.bin'
  }
}

function normalizeDownloadOptions(optionsOrHeaders?: DownloadOptions | Record<string, string>): DownloadOptions {
  if (!optionsOrHeaders) {
    return {}
  }

  if ('headers' in optionsOrHeaders || 'maxBytes' in optionsOrHeaders || 'allowPrivate' in optionsOrHeaders) {
    return optionsOrHeaders as DownloadOptions
  }

  return {
    headers: optionsOrHeaders as Record<string, string>,
  }
}

async function assertSafeExternalUrl(ctx: Context, url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) {
    return
  }

  if (!isSafePublicHttpUrl(url)) {
    throw new Error(`blocked unsafe media url: ${url}`)
  }

  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    hostname = ''
  }

  const isLocalChecker = (ctx as any).http?.isLocal
  if (typeof isLocalChecker === 'function') {
    if (hostname && TRUSTED_PUBLIC_MEDIA_HOST_RE.test(hostname)) {
      return
    }

    const isLocal = await Promise
      .resolve(isLocalChecker.call((ctx as any).http, url))
      .catch(() => false)

    if (isLocal) {
      throw new Error(`blocked local/private media url: ${url}`)
    }
  }
}

async function readStreamWithLimit(stream: ReadableStream<Uint8Array>, maxBytes?: number): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (!value) {
        continue
      }

      total += value.byteLength
      if (maxBytes && total > maxBytes) {
        await reader.cancel('maxBytes exceeded')
        throw new Error(`media too large: ${total} > ${maxBytes}`)
      }

      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, total)
}
