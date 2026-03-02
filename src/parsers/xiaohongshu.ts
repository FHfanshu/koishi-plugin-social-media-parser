import type { Context, Logger } from 'koishi'
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

import type { Config } from '../config'
import type { ParsedContent } from '../types'
import { requestText, resolveRedirect } from '../utils/http'
import { normalizeInputUrl } from '../utils/url'

export async function parseXiaohongshu(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  const normalized = normalizeInputUrl(inputUrl)
  if (!normalized) {
    throw new Error('小红书链接无效或域名不受支持')
  }

  const finalUrl = await resolveRedirect(ctx, normalized, config.timeoutMs, logger)
  const html = await fetchHtml(ctx, finalUrl, config, logger)
  const parsed = parseNoteFromHtml(html, finalUrl, config, logger)

  return {
    platform: 'xiaohongshu',
    title: parsed.title || '未命名笔记',
    content: parsed.content || '',
    images: parsed.images.slice(0, config.xiaohongshu.maxImages),
    videos: parsed.videos,
    originalUrl: inputUrl,
    resolvedUrl: finalUrl,
  }
}

interface ParsedXhsNote {
  title: string
  content: string
  images: string[]
  videos: string[]
  coverImage?: string
}

async function fetchHtml(ctx: Context, url: string, config: Config, logger: Logger): Promise<string> {
  const headers = {
    'User-Agent': config.xiaohongshu.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= config.xiaohongshu.maxRetries; attempt += 1) {
    try {
      const html = await requestText(ctx, url, config.timeoutMs, headers)
      if (!html || typeof html !== 'string') {
        throw new Error('empty html response')
      }
      return html
    } catch (error) {
      lastError = error
      logger.debug(`xhs fetch failed (${attempt}/${config.xiaohongshu.maxRetries}): ${String((error as Error)?.message || error)}`)
      if (attempt < config.xiaohongshu.maxRetries) {
        await sleep(attempt * 400)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('抓取小红书页面失败')
}

function parseNoteFromHtml(html: string, url: string, config: Config, logger: Logger): ParsedXhsNote {
  const $ = cheerio.load(html)
  const note: ParsedXhsNote = {
    title: '',
    content: '',
    images: [],
    videos: [],
  }

  const metaTitle = pickFirstString(
    $('meta[property="og:title"]').attr('content'),
    $('title').text()
  )
  const metaDescription = pickFirstString(
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="description"]').attr('content')
  )
  const metaCover = pickFirstString(
    $('meta[property="og:image"]').attr('content'),
    $('meta[name="og:image"]').attr('content')
  )

  const jsonLd = extractJsonLdData($)
  if (jsonLd) {
    const title = pickFirstString(jsonLd.headline, jsonLd.alternativeHeadline, jsonLd.name)
    const content = pickFirstString(jsonLd.articleBody, jsonLd.description)
    const images = normalizeImageField(jsonLd.image)
    const videos = normalizeVideoField(jsonLd.video ?? jsonLd.videoUrl ?? jsonLd.videoObject)

    if (title) note.title = title
    if (content) note.content = content
    if (images.length) note.images.push(...images)
    if (videos.length) note.videos.push(...videos)
  }

  const initialState = extractInitialState($)
  if (initialState) {
    const noteId = extractNoteIdFromUrl(url) ?? extractNoteIdFromPage($)
    const detail = findNoteDetail(initialState, noteId)
    if (detail) {
      mergeNoteDetail(note, detail, logger)
    }
  }

  if (!note.title) {
    note.title = metaTitle || '未能获取标题'
  }
  if (!note.content) {
    note.content = metaDescription || ''
  }

  note.images = dedupeUrls(note.images)
  note.videos = dedupeVideoUrls(note.videos)

  if (!note.images.length && metaCover) {
    note.images.push(metaCover)
  }
  note.coverImage = note.images[0]

  logger.debug(`xhs parsed: title=${note.title}, images=${note.images.length}, videos=${note.videos.length}`)

  return note
}

function extractJsonLdData($: CheerioAPI): Record<string, any> | null {
  const scripts = $('script[type="application/ld+json"]')
  for (const element of scripts.toArray()) {
    const content = $(element).text().trim()
    if (!content) {
      continue
    }

    const parsed = safeJsonParse(content)
    if (!parsed) {
      continue
    }

    const candidate = findJsonLdCandidate(parsed)
    if (candidate) {
      return candidate
    }
  }

  return null
}

function findJsonLdCandidate(data: unknown): Record<string, any> | null {
  if (!data) {
    return null
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findJsonLdCandidate(item)
      if (found) {
        return found
      }
    }
    return null
  }

  if (typeof data !== 'object') {
    return null
  }

  const record = data as Record<string, any>
  if (matchesJsonLdType(record['@type'])) {
    return record
  }

  if (record['@graph']) {
    const found = findJsonLdCandidate(record['@graph'])
    if (found) {
      return found
    }
  }

  if (record.mainEntity) {
    const found = findJsonLdCandidate(record.mainEntity)
    if (found) {
      return found
    }
  }

  return null
}

function matchesJsonLdType(type: unknown): boolean {
  if (!type) {
    return false
  }

  const values = Array.isArray(type) ? type : [type]
  return values.some((value) => {
    if (typeof value !== 'string') {
      return false
    }
    return ['NewsArticle', 'Article', 'BlogPosting', 'SocialMediaPosting', 'CreativeWork'].includes(value)
  })
}

function extractInitialState($: CheerioAPI): Record<string, any> | null {
  const scripts = $('script').toArray()
  for (const element of scripts) {
    const content = $(element).html() || ''
    if (!content) {
      continue
    }

    const state =
      extractJsonFromAssignment(content, 'window.__INITIAL_STATE__')
      || extractJsonFromAssignment(content, '__INITIAL_STATE__')
      || extractJsonFromAssignment(content, 'window.__INITIAL_DATA__')
      || extractJsonFromAssignment(content, '__INITIAL_DATA__')

    if (state) {
      return state
    }
  }

  return null
}

function extractJsonFromAssignment(script: string, variableName: string): Record<string, any> | null {
  const index = script.indexOf(variableName)
  if (index < 0) {
    return null
  }

  const start = script.indexOf('{', index)
  if (start < 0) {
    return null
  }

  let depth = 0
  let inString: string | null = null
  let escaped = false

  for (let i = start; i < script.length; i += 1) {
    const char = script[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inString) {
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === inString) {
        inString = null
      }
      continue
    }

    if (char === '"' || char === '\'') {
      inString = char
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const jsonText = script.slice(start, i + 1)
        const parsed = safeJsonParse(jsonText)
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, any>
        }
        break
      }
    }
  }

  return null
}

function extractNoteIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname || ''

    const discoveryMatch = path.match(/\/discovery\/item\/([^/?#]+)/i)
    if (discoveryMatch?.[1]) {
      return discoveryMatch[1]
    }

    const match = path.match(/\/(explore|item|note|notes|post|detail)\/([^/?#]+)/i)
    if (match?.[2]) {
      return match[2]
    }

    for (const key of ['note_id', 'noteId', 'id', 'noteid']) {
      const value = parsed.searchParams.get(key)
      if (value?.trim()) {
        return value.trim()
      }
    }
  } catch {
    return null
  }

  return null
}

function extractNoteIdFromPage($: CheerioAPI): string | null {
  const metaNoteId = $('meta[name="note-id"]').attr('content')
  if (metaNoteId?.trim()) {
    return metaNoteId.trim()
  }

  const ogUrl = $('meta[property="og:url"]').attr('content')
  if (ogUrl) {
    const fromOg = extractNoteIdFromUrl(ogUrl)
    if (fromOg) {
      return fromOg
    }
  }

  const dataAttr = $('[data-note-id]').attr('data-note-id')
  if (dataAttr?.trim()) {
    return dataAttr.trim()
  }

  return null
}

function findNoteDetail(state: unknown, noteId: string | null): Record<string, any> | null {
  if (!state || typeof state !== 'object') {
    return null
  }

  const queue: unknown[] = [state]
  const visited = new Set<unknown>()

  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') {
      continue
    }
    if (visited.has(current)) {
      continue
    }
    visited.add(current)

    const record = current as Record<string, any>
    if (isNoteDetail(record, noteId)) {
      return record
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }

  return null
}

function isNoteDetail(record: Record<string, any>, noteId: string | null): boolean {
  if (noteId) {
    if (record.noteId === noteId || record.id === noteId) {
      return true
    }

    if (record.note && typeof record.note === 'object') {
      const noteRecord = record.note as Record<string, any>
      if (noteRecord.noteId === noteId || noteRecord.id === noteId) {
        return true
      }
    }
  }

  const keys = ['noteCard', 'noteInfo', 'imageList', 'imageUrls', 'desc', 'noteContent']
  return keys.some((key) => key in record)
}

function mergeNoteDetail(note: ParsedXhsNote, detail: Record<string, any>, logger: Logger): void {
  const candidates = collectNoteCandidates(detail)

  for (const record of candidates) {
    const title = pickFirstString(
      record.title,
      record.noteTitle,
      record.displayTitle,
      record.shareTitle,
      record.name,
      record.note?.title,
      record.noteCard?.title
    )
    if (title) {
      note.title = title
    }

    const content = extractTextFromDetail(record)
    if (content) {
      note.content = content
    }

    const images = extractImagesFromDetail(record)
    if (images.length) {
      note.images.push(...images)
    }

    const videos = extractVideosFromDetail(record)
    if (videos.length) {
      note.videos.push(...videos)
    }
  }

  logger.debug(`xhs detail merged: images=${note.images.length}, videos=${note.videos.length}`)
}

function collectNoteCandidates(source: Record<string, any>): Record<string, any>[] {
  const result: Record<string, any>[] = []
  const queue: unknown[] = [source]
  const visited = new Set<unknown>()

  while (queue.length && result.length < 20) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') {
      continue
    }
    if (visited.has(current)) {
      continue
    }
    visited.add(current)

    const record = current as Record<string, any>
    result.push(record)

    for (const key of ['note', 'noteCard', 'noteInfo', 'noteDetail', 'mainNote', 'targetNote', 'data']) {
      const value = record[key]
      if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }

  return result
}

function extractTextFromDetail(record: Record<string, any>): string {
  const segments: string[] = []
  const pushText = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        segments.push(trimmed)
      }
    }
  }

  pushText(record.desc)
  pushText(record.displayDesc)
  pushText(record.content)
  pushText(record.noteContent)
  pushText(record.note?.desc)
  pushText(record.note?.content)
  pushText(record.noteCard?.desc)
  pushText(record.noteCard?.noteContent)

  return Array.from(new Set(segments)).join('\n\n').trim()
}

function extractImagesFromDetail(record: Record<string, any>): string[] {
  const results: string[] = []
  const seenImageIds = new Set<string>()

  const pushValue = (value: unknown): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        pushValue(item)
      }
      return
    }

    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        results.push(trimmed)
      }
      return
    }

    if (typeof value !== 'object') {
      return
    }

    const data = value as Record<string, unknown>
    const imageId = extractImageId(data)
    if (imageId && seenImageIds.has(imageId)) {
      return
    }

    const selected = selectBestImageUrl(data)
    if (!selected) {
      return
    }

    if (imageId) {
      seenImageIds.add(imageId)
    }
    results.push(selected)
  }

  const primaryCandidates: unknown[] = [
    record.imageList,
    record.noteCard?.imageList,
    record.note?.imageList,
    record.imageUrls,
    record.noteCard?.imageUrls,
    record.note?.imageUrls,
    record.images,
    record.imagesList,
  ]

  for (const candidate of primaryCandidates) {
    if (Array.isArray(candidate) && candidate.length) {
      pushValue(candidate)
      if (results.length) {
        break
      }
    }
  }

  if (!results.length) {
    pushValue(record.cover)
    pushValue(record.noteCard?.cover)
    pushValue(record.note?.cover)
  }

  return results
}

function extractVideosFromDetail(record: Record<string, any>): string[] {
  const results: string[] = []

  const pushValue = (value: unknown): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        pushValue(item)
      }
      return
    }

    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('http')) {
        results.push(trimmed)
      }
      return
    }

    if (typeof value !== 'object') {
      return
    }

    const data = value as Record<string, unknown>
    for (const key of [
      'playUrl',
      'play_url',
      'videoUrl',
      'mainUrl',
      'masterUrl',
      'backupUrl',
      'url',
      'contentUrl',
      'h264',
      'h265',
      'mp4Url',
      'dashUrl',
    ]) {
      const raw = data[key]
      if (typeof raw === 'string' && raw.trim().startsWith('http')) {
        results.push(raw.trim())
        break
      }
    }
  }

  for (const candidate of [
    record.videoUrl,
    record.mainUrl,
    record.masterUrl,
    record.backupUrl,
    record.playUrl,
    record.video,
    record.videos,
    record.videoInfo,
    record.videoList,
    record.note?.video,
    record.noteCard?.video,
  ]) {
    pushValue(candidate)
  }

  if (!results.length) {
    const queue: unknown[] = [record]
    const seen = new Set<unknown>()
    const videoPattern = /\.(mp4|m3u8|flv|m4s)(\?|$)/i

    while (queue.length && results.length < 10) {
      const current = queue.shift()
      if (!current || typeof current !== 'object' || seen.has(current)) {
        continue
      }
      seen.add(current)

      for (const value of Object.values(current as Record<string, unknown>)) {
        if (typeof value === 'string' && value.startsWith('http') && videoPattern.test(value)) {
          results.push(value.trim())
        } else if (value && typeof value === 'object') {
          queue.push(value)
        }
      }
    }
  }

  return results
}

function extractImageId(data: Record<string, unknown>): string | null {
  for (const key of ['fileId', 'imageId', 'id', 'traceId', 'url_default', 'originUrl']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  if (Array.isArray(data.infoList) && data.infoList.length > 0) {
    const first = data.infoList[0]
    if (first && typeof first === 'object') {
      return extractImageId(first as Record<string, unknown>)
    }
  }

  return null
}

function selectBestImageUrl(data: Record<string, unknown>): string | null {
  const infoList = Array.isArray(data.infoList) ? data.infoList : null
  if (infoList?.length) {
    let best: { url: string; score: number } | null = null
    for (const item of infoList) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const record = item as Record<string, unknown>
      const url =
        typeof record.url === 'string'
          ? record.url.trim()
          : typeof record.src === 'string'
            ? record.src.trim()
            : ''

      if (!url) {
        continue
      }

      const scene = typeof record.imageScene === 'string' ? record.imageScene : ''
      const score = getImageSceneScore(scene)
      if (!best || score > best.score) {
        best = { url, score }
      }
    }
    if (best?.url) {
      return best.url
    }
  }

  for (const key of ['originUrl', 'url', 'urlDefault', 'imageUrl', 'contentUrl', 'cover', 'src', 'thumbnailUrl', 'urlPre']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function getImageSceneScore(scene: string): number {
  const value = scene.toUpperCase()
  if (value.includes('ORI')) return 5
  if (value.includes('DFT') || value.includes('DEFAULT')) return 4
  if (value.includes('HD')) return 3
  if (value.includes('MID')) return 2
  if (value.includes('PRV') || value.includes('PRE') || value.includes('LOW')) return 1
  return 0
}

function normalizeImageField(imageField: unknown): string[] {
  const results: string[] = []
  const push = (value: unknown): void => {
    if (!value) {
      return
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        results.push(trimmed)
      }
      return
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      const candidate = record.url || record.contentUrl || record.image || record.thumbnailUrl
      if (typeof candidate === 'string' && candidate.trim()) {
        results.push(candidate.trim())
      }
    }
  }

  if (Array.isArray(imageField)) {
    for (const item of imageField) {
      push(item)
    }
  } else {
    push(imageField)
  }

  return results
}

function normalizeVideoField(videoField: unknown): string[] {
  const results: string[] = []
  const push = (value: unknown): void => {
    if (!value) {
      return
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        results.push(trimmed)
      }
      return
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      const candidate = record.contentUrl || record.url || record.embedUrl
      if (typeof candidate === 'string' && candidate.trim()) {
        results.push(candidate.trim())
      }
    }
  }

  if (Array.isArray(videoField)) {
    for (const item of videoField) {
      push(item)
    }
  } else {
    push(videoField)
  }

  return results
}

function dedupeUrls(urls: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const url of urls) {
    const trimmed = url.trim()
    if (!trimmed) {
      continue
    }
    if (seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

function dedupeVideoUrls(urls: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const url of urls) {
    const normalized = normalizeSingleVideoUrl(url)
    if (!normalized) {
      continue
    }

    const key = videoCanonicalKey(normalized)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(normalized)
  }

  return result
}

function videoCanonicalKey(urlText: string): string {
  const trimmed = urlText.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const url = new URL(trimmed)
    if (url.hostname.endsWith('xhscdn.com') && url.pathname.includes('/stream/')) {
      return url.pathname
    }
    return trimmed
  } catch {
    return trimmed
  }
}

function normalizeSingleVideoUrl(urlText: string): string | null {
  const trimmed = urlText.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' && url.hostname.endsWith('xhscdn.com')) {
      url.protocol = 'https:'
      return url.toString()
    }
    return trimmed
  } catch {
    if (trimmed.startsWith('http')) {
      return trimmed
    }
    return null
  }
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function safeJsonParse(text: string): unknown {
  const payload = sanitizePotentialJson(text)
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function sanitizePotentialJson(value: string): string {
  return value
    .replace(/\bundefined\b/g, 'null')
    .replace(/\bNaN\b/g, 'null')
    .replace(/\bInfinity\b/g, 'null')
    .replace(/-null/g, 'null')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
