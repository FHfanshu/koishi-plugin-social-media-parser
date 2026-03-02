import type { Context, Logger } from 'koishi'

export interface DownloadedBuffer {
  buffer: Buffer
  mimeType: string
  url: string
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

export async function resolveRedirect(
  ctx: Context,
  url: string,
  timeoutMs: number,
  logger?: Logger
): Promise<string> {
  let current = url
  for (let i = 0; i < 6; i += 1) {
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
      try {
        current = new URL(location, response.url || current).toString()
      } catch {
        current = location
      }
      continue
    }

    if (typeof response.url === 'string' && response.url) {
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
  headers?: Record<string, string>
): Promise<DownloadedBuffer> {
  const file = await ctx.http.file(url, {
    timeout: timeoutMs,
    headers: {
      'user-agent': DEFAULT_UA,
      ...headers,
    },
  } as any)

  const buffer = Buffer.from(file.data)
  const mimeType = normalizeMimeType((file as any).type || (file as any).mime || '') || guessMimeFromUrl(url)

  return {
    buffer,
    mimeType,
    url,
  }
}

export async function requestText(
  ctx: Context,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<string> {
  return ctx.http.get(url, {
    timeout: timeoutMs,
    responseType: 'text',
    headers: {
      'user-agent': DEFAULT_UA,
      ...headers,
    },
  } as any)
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
      return '.bin'
  }
}
