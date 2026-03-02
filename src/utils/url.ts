import { isIP } from 'node:net'

import type { Session } from 'koishi'

import type { SocialPlatform } from '../types'

const URL_EXTRACT_PATTERN = /https?:\/\/[^\s]+/gi
const TRAILING_PUNCTUATION_PATTERN = /[)\]\}>"'。！？!?！，,。.、；：…]+$/u
const HTML_ENTITY_REGEX = /&(#x?[0-9a-f]+|\w+);/gi
const PRIVATE_IPV4_REGEX = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/
const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.localhost']

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const DOUYIN_HOST_RE = /(^|\.)((v\.douyin\.com)|(www\.douyin\.com)|(www\.iesdouyin\.com))$/i
const XIAOHONGSHU_HOST_RE = /(^|\.)((xiaohongshu\.com)|(xhslink\.com))$/i
const BILIBILI_HOST_RE = /(^|\.)((bilibili\.com)|(b23\.tv)|(bili22\.cn)|(bili23\.cn)|(bili33\.cn)|(bili2233\.cn))$/i

export function decodeHtmlEntities(value: string): string {
  if (!value || !value.includes('&')) {
    return value
  }

  return value.replace(HTML_ENTITY_REGEX, (match, entity) => {
    if (!entity) {
      return match
    }
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x'
      const text = isHex ? entity.slice(2) : entity.slice(1)
      const codePoint = Number.parseInt(text, isHex ? 16 : 10)
      if (Number.isNaN(codePoint)) {
        return match
      }
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }

    return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match
  })
}

export function sanitizeExtractedUrl(raw: string): string {
  return decodeHtmlEntities(raw.replace(TRAILING_PUNCTUATION_PATTERN, '').trim())
}

export function extractCandidateUrls(text: string): string[] {
  if (!text) {
    return []
  }

  const matches = text.match(URL_EXTRACT_PATTERN) ?? []
  return dedupe(matches.map((item) => sanitizeExtractedUrl(item)).filter(Boolean))
}

export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) {
    return true
  }

  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') {
    return true
  }

  if (PRIVATE_IPV4_REGEX.test(normalized)) {
    return true
  }

  if (isIP(normalized) === 6 && isPrivateIpv6(normalized)) {
    return true
  }

  return PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

export function isSafePublicHttpUrl(input: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  return !isPrivateHostname(parsed.hostname)
}

export function detectPlatformByUrl(input: string): SocialPlatform | null {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }

  const host = parsed.hostname.toLowerCase()
  if (DOUYIN_HOST_RE.test(host)) {
    return 'douyin'
  }
  if (XIAOHONGSHU_HOST_RE.test(host)) {
    return 'xiaohongshu'
  }
  if (BILIBILI_HOST_RE.test(host)) {
    return 'bilibili'
  }

  return null
}

export function normalizeInputUrl(input: string): string | null {
  if (!input) {
    return null
  }

  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const direct = normalizeSingleUrl(trimmed)
  if (direct) {
    return direct
  }

  const candidates = extractCandidateUrls(trimmed)
  for (const candidate of candidates) {
    const normalized = normalizeSingleUrl(candidate)
    if (normalized) {
      return normalized
    }
  }

  return null
}

function normalizeSingleUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    try {
      parsed = new URL(`https://${raw}`)
    } catch {
      return null
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return null
  }

  const hostname = parsed.hostname.toLowerCase()
  if (isPrivateHostname(hostname)) {
    return null
  }

  if (!detectPlatformByUrl(parsed.toString())) {
    return null
  }

  parsed.hash = ''
  return parsed.toString()
}

export function extractSocialUrlsFromSession(session: Session): string[] {
  const urls: string[] = []

  if (typeof session.content === 'string') {
    urls.push(...extractCandidateUrls(session.content))
  }

  const elements = (session as any).elements
  if (Array.isArray(elements)) {
    urls.push(...extractUrlsFromAny(elements))

    for (const element of elements) {
      if (!element || typeof element !== 'object') {
        continue
      }

      if (element.type !== 'json') {
        continue
      }

      const raw = element.attrs?.data ?? element.attrs?.content ?? element.data?.data ?? element.data?.content
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(decodeHtmlEntities(raw))
          urls.push(...extractUrlsFromAny(parsed))
        } catch {
          urls.push(...extractCandidateUrls(raw))
        }
      } else {
        urls.push(...extractUrlsFromAny(raw))
      }
    }
  }

  return dedupe(
    urls
      .map((url) => normalizeSingleUrl(url))
      .filter((url): url is string => Boolean(url))
  )
}

export function isWhitelisted(session: Session, guilds: string[], users: string[]): boolean {
  const platform = typeof session.platform === 'string' ? session.platform : ''
  const guildId = typeof session.guildId === 'string' ? session.guildId : ''
  const channelId = typeof session.channelId === 'string' ? session.channelId : ''
  const userId = typeof session.userId === 'string' ? session.userId : ''

  if (matchId(guildId, platform, guilds)) {
    return true
  }
  if (matchId(channelId, platform, guilds)) {
    return true
  }
  if (matchId(userId, platform, users)) {
    return true
  }

  return false
}

function matchId(value: string, platform: string, entries: string[]): boolean {
  if (!value || !entries?.length) {
    return false
  }

  for (const entry of entries) {
    if (!entry) {
      continue
    }

    if (entry.includes(':')) {
      if (entry === `${platform}:${value}`) {
        return true
      }
      continue
    }

    if (entry === value) {
      return true
    }
  }

  return false
}

function extractUrlsFromAny(value: unknown): string[] {
  const results: string[] = []
  const visited = new Set<unknown>()

  const walk = (current: unknown): void => {
    if (!current) {
      return
    }

    if (typeof current === 'string') {
      results.push(...extractCandidateUrls(current))
      return
    }

    if (typeof current !== 'object') {
      return
    }

    if (visited.has(current)) {
      return
    }
    visited.add(current)

    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item)
      }
      return
    }

    for (const key of Object.keys(current)) {
      walk((current as Record<string, unknown>)[key])
    }
  }

  walk(value)
  return dedupe(results)
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list))
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === '::1') {
    return true
  }

  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
}
