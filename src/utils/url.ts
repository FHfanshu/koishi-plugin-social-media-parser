import { isIP } from 'node:net'

import type { Session } from 'koishi'

import type { SocialPlatform } from '../types'

const URL_EXTRACT_PATTERN = /https?:\/\/[^\s]+/gi
const ESCAPED_URL_EXTRACT_PATTERN = /https?:\\\/\\\/[^\s]+/gi
const DOUYIN_LOOSE_URL_PATTERN = /https?:\/\/\s*(?:v\s*\.\s*d\s*o\s*u\s*y\s*i\s*n\s*\.\s*c\s*o\s*m|w\s*w\s*w\s*\.\s*d\s*o\s*u\s*y\s*i\s*n\s*\.\s*c\s*o\s*m|w\s*w\s*w\s*\.\s*i\s*e\s*s\s*d\s*o\s*u\s*y\s*i\s*n\s*\.\s*c\s*o\s*m)\s*\/\s*[a-zA-Z0-9_-]+\/?/gi
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
const TWITTER_HOST_RE = /(^|\.)((x\.com)|(twitter\.com)|(mobile\.x\.com)|(mobile\.twitter\.com)|(m\.twitter\.com)|(t\.co)|(fxtwitter\.com)|(vxtwitter\.com))$/i

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
  return decodeEscapedUrl(decodeHtmlEntities(raw)).replace(TRAILING_PUNCTUATION_PATTERN, '').trim()
}

export function extractCandidateUrls(text: string): string[] {
  if (!text) {
    return []
  }

  const matches = text.match(URL_EXTRACT_PATTERN) ?? []
  const escapedMatches = text.match(ESCAPED_URL_EXTRACT_PATTERN) ?? []
  const looseMatches = text.match(DOUYIN_LOOSE_URL_PATTERN) ?? []

  return dedupe(
    [
      ...matches,
      ...escapedMatches.map((value) => decodeEscapedUrl(value)),
      ...looseMatches.map((value) => compactLooseUrl(value)),
    ]
      .map((item) => sanitizeExtractedUrl(item))
      .filter(Boolean)
  )
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
  if (!input || typeof input !== 'string') {
    return false
  }

  // Handle protocol-relative URLs (e.g., //example.com/path)
  // These are valid and should be treated as HTTPS
  let normalizedInput = input.trim()
  if (normalizedInput.startsWith('//')) {
    normalizedInput = `https:${normalizedInput}`
  }

  let parsed: URL
  try {
    parsed = new URL(normalizedInput)
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
  if (TWITTER_HOST_RE.test(host)) {
    return 'twitter'
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

  normalizeKnownSharePath(parsed)

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
    for (const element of elements) {
      if (!element || typeof element !== 'object') {
        continue
      }

      // 分享卡片直接用正则匹配URL
      if (element.type === 'json' || element.type === 'xml' || element.type === 'app') {
        const raw = element.attrs?.data ?? element.attrs?.content ?? element.data?.data ?? element.data?.content
        if (typeof raw === 'string') {
          // 直接用正则提取，不尝试JSON解析
          urls.push(...extractCandidateUrls(decodeEscapedUrl(decodeHtmlEntities(raw))))
        }
      } else {
        // 其他元素类型递归提取
        urls.push(...extractUrlsFromAny(element))
      }
    }
  }

  const normalized = urls
    .map((url) => normalizeSingleUrl(url))
    .filter((url): url is string => Boolean(url))

  return dedupeByCanonicalPath(normalized)
}

export function isBlocked(session: Session, blockedGuilds: string[], blockedUsers: string[]): boolean {
  return isGuildBlocked(session, blockedGuilds) || isUserBlocked(session, blockedUsers)
}

export function isGuildBlocked(session: Session, blockedGuilds: string[]): boolean {
  const platform = typeof session.platform === 'string' ? session.platform : ''
  const guildId = typeof session.guildId === 'string' ? session.guildId : ''
  const channelId = typeof session.channelId === 'string' ? session.channelId : ''

  if (matchId(guildId, platform, blockedGuilds)) {
    return true
  }
  if (matchId(channelId, platform, blockedGuilds)) {
    return true
  }

  return false
}

export function isUserBlocked(session: Session, blockedUsers: string[]): boolean {
  const platform = typeof session.platform === 'string' ? session.platform : ''
  const userId = typeof session.userId === 'string' ? session.userId : ''
  if (matchId(userId, platform, blockedUsers)) {
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

function dedupeByCanonicalPath(urls: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const url of urls) {
    const key = canonicalUrlKey(url)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(url)
  }

  return result
}

function canonicalUrlKey(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.replace(/\/+$/, '')

    if (XIAOHONGSHU_HOST_RE.test(host)) {
      const noteMatch = path.match(/\/(explore|item|note|notes|post|detail|discovery\/item)\/([^/?#]+)/i)
      if (noteMatch?.[2]) {
        return `xhs:${noteMatch[2]}`
      }
    }

    if (DOUYIN_HOST_RE.test(host)) {
      const videoMatch = path.match(/\/(?:video|note)\/(\d+)/i)
      if (videoMatch?.[1]) {
        return `douyin:${videoMatch[1]}`
      }
    }

    if (BILIBILI_HOST_RE.test(host)) {
      const bvMatch = path.match(/\/(BV[a-zA-Z0-9]+)/i)
      if (bvMatch?.[1]) {
        return `bili:${bvMatch[1]}`
      }
      const avMatch = path.match(/\/av(\d+)/i)
      if (avMatch?.[1]) {
        return `bili:av${avMatch[1]}`
      }
    }

    return `${host}${path}`
  } catch {
    return url
  }
}

function decodeEscapedUrl(value: string): string {
  return value
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
}

function compactLooseUrl(value: string): string {
  if (!value) {
    return value
  }

  return value
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, '')
}

function normalizeKnownSharePath(parsed: URL): void {
  const hostname = parsed.hostname.toLowerCase()
  const isKnownShortHost = hostname === 'b23.tv'
    || hostname.endsWith('.b23.tv')
    || hostname === 'xhslink.com'
    || hostname.endsWith('.xhslink.com')
    || hostname === 'v.douyin.com'

  if (!isKnownShortHost) {
    return
  }

  parsed.search = ''

  const token = parsed.pathname.split('/').filter(Boolean)[0]
  if (!token) {
    return
  }

  const cleanedToken = token.replace(/(?:%22|%27|%2C|%7B|%7D|["',{}]).*$/i, '')
  if (!cleanedToken || cleanedToken === token) {
    return
  }

  parsed.pathname = `/${cleanedToken}`
  parsed.search = ''
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
