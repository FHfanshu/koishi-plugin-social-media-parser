import { Schema } from 'koishi'

import type { SendMode, VideoSendMode } from './types'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface MediaInjectConfig {
  enabled: boolean
  maxImages: number
  imageMaxEdgePx: number
  imageQuality: number
  videoEnabled: boolean
  videoResolution: 480 | 720
  videoMaxDurationSec: number
  longVideoFrameIntervalSec: number
  longVideoMaxFrames: number
  keepAudio: boolean
  maxTotalBytes: number
  ffmpegTimeoutMs: number
}

export interface NetworkConfig {
  timeoutMs: number
  cooldownMs: number
}

export interface VideoCacheConfig {
  enabled: boolean
  ttlMs: number
  maxSizeBytes: number
  maxEntries: number
}

export interface MediaConfig {
  maxBytes: number
  maxVideoBytes: number
  maxDurationSec: number
  sendMode: SendMode
  videoSendMode: VideoSendMode
  fallbackToUrlOnError: boolean
  videoCache: VideoCacheConfig
}

export interface DouyinConfig {
  enabled: boolean
  api: {
    baseUrl: string
    fallbackUrls: string[]
  }
  maxImages: number
  autoParseBlockedGuilds: string[]
}

export interface XiaohongshuConfig {
  enabled: boolean
  userAgent: string
  maxRetries: number
  maxImages: number
  autoParseBlockedGuilds: string[]
  useBrowser: boolean
  browserTimeout: number
  cookies: string
}

export interface BilibiliConfig {
  enabled: boolean
  fetchVideo: boolean
  videoQuality: 480 | 720
  maxDescLength: number
  autoParseBlockedGuilds: string[]
}

export interface TwitterConfig {
  enabled: boolean
  maxImages: number
  grok: {
    enabled: boolean
    baseUrl?: string
    apiKey?: string
    model: string
    timeoutMs: number
  }
  routing: {
    textProviderOrder: string
    imageProviderOrder: string
    videoProviderOrder: string
    translationProviderOrder: string
  }
  translation: {
    enabled: boolean
    targetLanguage: string
    maxChars: number
    showOriginal: boolean
  }
  autoParseBlockedGuilds: string[]
}

export interface PlatformsConfig {
  douyin: DouyinConfig
  xiaohongshu: XiaohongshuConfig
  bilibili: BilibiliConfig
  twitter: TwitterConfig
}

export interface ForwardConfig {
  enabled: boolean
  nickname: string
  includeMusic: boolean
  autoMergeForward: boolean
  longTextThreshold: number
  imageMergeThreshold: number
  maxForwardImages: number
  textChunkSize: number
  maxForwardNodes: number
}

export interface ToolConfig {
  enabled: boolean
  name: string
  description: string
}

export interface AutoParseConfig {
  enabled: boolean
  onlyGroup: boolean
  blacklist: {
    guilds: string[] // legacy global guild blacklist, kept for backward compatibility
    users: string[]
  }
  maxUrlsPerMessage: number
}

export interface Config {
  network: NetworkConfig
  media: MediaConfig
  platforms: PlatformsConfig
  forward: ForwardConfig
  tool: ToolConfig
  autoParse: AutoParseConfig
  debug: boolean
}

export const DEFAULT_VIDEO_CACHE_CONFIG: VideoCacheConfig = {
  enabled: true,
  ttlMs: 30 * 60 * 1000,
  maxSizeBytes: 200 * 1024 * 1024,
  maxEntries: 20,
}

export const DEFAULT_MEDIA_INJECT_CONFIG: MediaInjectConfig = {
  enabled: true,
  maxImages: 3,
  imageMaxEdgePx: 800,
  imageQuality: 75,
  videoEnabled: true,
  videoResolution: 480,
  videoMaxDurationSec: 60,
  longVideoFrameIntervalSec: 5,
  longVideoMaxFrames: 12,
  keepAudio: true,
  maxTotalBytes: 10 * 1024 * 1024,
  ffmpegTimeoutMs: 120_000, // 2 minutes default, will be dynamically adjusted based on video duration
}

export const Config: Schema<Config> = Schema.intersect([
  // ── 通用 ──────────────────────────────────────────────
  Schema.object({
    debug: Schema.boolean().default(false).description('调试模式（输出详细日志）'),
  }).description('通用'),

  // ── 网络 ──────────────────────────────────────────────
  Schema.object({
    network: Schema.object({
      timeoutMs: Schema.number().default(15_000).description('请求超时（ms）'),
      cooldownMs: Schema.number().default(8_000).description('同一链接冷却（ms）'),
    }),
  }).description('网络'),

  // ── 媒体 ──────────────────────────────────────────────
  Schema.object({
    media: Schema.object({
      // 限制
      maxBytes: Schema.number().default(15 * 1024 * 1024).description('单媒体最大下载量（bytes）'),
      maxVideoBytes: Schema.number().default(512 * 1024 * 1024).min(8 * 1024 * 1024).max(2 * 1024 * 1024 * 1024).description('视频最大下载量（bytes，建议 > maxBytes）'),
      maxDurationSec: Schema.number().default(1800).min(60).max(7200).description('视频最大时长（秒）'),
      // 发送
      sendMode: Schema.union([
        Schema.const('base64').description('base64 内联（最稳）'),
        Schema.const('storage').description('chatluna storage 托管（无 storage 回退 base64）'),
        Schema.const('url').description('直接 URL（最省流量）'),
      ]).default('base64').description('图片发送模式'),
      videoSendMode: Schema.union([
        Schema.const('storage').description('chatluna storage 托管'),
        Schema.const('base64').description('base64 内联（OneBot 较稳）'),
        Schema.const('url').description('视频直链（兼容性最差）'),
      ]).default('base64').description('视频发送模式'),
      fallbackToUrlOnError: Schema.boolean().default(true).description('发送失败时回退到直链'),
      // 缓存
      videoCache: Schema.object({
        enabled: Schema.boolean().default(true).description('启用（同视频多群复用）'),
        ttlMs: Schema.number().default(30 * 60 * 1000).min(60_000).max(24 * 60 * 60 * 1000).description('有效期（ms）'),
        maxSizeBytes: Schema.number().default(200 * 1024 * 1024).min(10 * 1024 * 1024).max(1024 * 1024 * 1024).description('最大缓存（bytes）'),
        maxEntries: Schema.number().default(20).min(1).max(100).description('最大条目数'),
      }),
    }),
  }).description('媒体'),

  // ── 平台：抖音 ────────────────────────────────────────
  Schema.object({
    platforms: Schema.object({
      douyin: Schema.object({
        enabled: Schema.boolean().default(true).description('启用'),
        api: Schema.object({
          baseUrl: Schema.string().default('https://api.douyin.wtf').description('主 API 地址'),
          fallbackUrls: Schema.array(String).role('table').default([]).description('备用 API 列表'),
        }).description('API'),
        maxImages: Schema.number().default(9).min(1).max(20).description('图文最大图片数'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析群黑名单'),
      }).description('抖音'),
    }),
  }).description('平台：抖音'),

  // ── 平台：小红书 ──────────────────────────────────────
  Schema.object({
    platforms: Schema.object({
      xiaohongshu: Schema.object({
        enabled: Schema.boolean().default(true).description('启用'),
        userAgent: Schema.string().default(DEFAULT_USER_AGENT).description('User-Agent'),
        maxRetries: Schema.number().default(3).min(1).max(6).description('重试次数'),
        maxImages: Schema.number().default(20).min(1).max(40).description('图文最大图片数'),
        useBrowser: Schema.boolean().default(false).description('浏览器模式（需 puppeteer）'),
        browserTimeout: Schema.number().default(30000).min(5000).max(120000).description('浏览器超时（ms）'),
        cookies: Schema.string().role('textarea').default('').description('登录 Cookie'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析群黑名单'),
      }).description('小红书'),
    }),
  }).description('平台：小红书'),

  // ── 平台：Bilibili ────────────────────────────────────
  Schema.object({
    platforms: Schema.object({
      bilibili: Schema.object({
        enabled: Schema.boolean().default(true).description('启用'),
        fetchVideo: Schema.boolean().default(true).description('获取视频直链'),
        videoQuality: Schema.union([
          Schema.const(480).description('480P'),
          Schema.const(720).description('720P'),
        ]).default(720).description('视频画质'),
        maxDescLength: Schema.number().default(100).min(20).max(500).description('简介最大长度'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析群黑名单'),
      }).description('Bilibili'),
    }),
  }).description('平台：Bilibili'),

  // ── 平台：Twitter/X ──────────────────────────────────
  Schema.object({
    platforms: Schema.object({
      twitter: Schema.object({
        enabled: Schema.boolean().default(false).description('启用'),
        maxImages: Schema.number().default(9).min(1).max(20).description('最大图片数'),
        grok: Schema.object({
          enabled: Schema.boolean().default(false).description('启用 Grok 解析'),
          model: Schema.dynamic('model').default('grok-4.1-fast').description('模型'),
          timeoutMs: Schema.number().default(35_000).min(3_000).max(180_000).description('超时（ms）'),
        }).description('Grok'),
        routing: Schema.object({
          textProviderOrder: Schema.string().default('fxtwitter,grok').description('文本优先级'),
          imageProviderOrder: Schema.string().default('fxtwitter,grok').description('图片优先级'),
          videoProviderOrder: Schema.string().default('fxtwitter,grok').description('视频优先级'),
          translationProviderOrder: Schema.string().default('grok').description('翻译优先级'),
        }).description('路由'),
        translation: Schema.object({
          enabled: Schema.boolean().default(false).description('启用翻译'),
          targetLanguage: Schema.string().default('zh-CN').description('目标语言'),
          maxChars: Schema.number().default(1200).min(80).max(10_000).description('截断上限'),
          showOriginal: Schema.boolean().default(true).description('保留原文'),
        }).description('翻译'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析群黑名单'),
      }).description('Twitter/X'),
    }),
  }).description('平台：Twitter/X'),

  // ── 自动解析 ──────────────────────────────────────────
  Schema.object({
    autoParse: Schema.object({
      enabled: Schema.boolean().default(true).description('启用'),
      onlyGroup: Schema.boolean().default(true).description('仅群聊触发'),
      blacklist: Schema.object({
        guilds: Schema.array(String).role('table').default([]).hidden().description('旧版全局群黑名单（兼容）'),
        users: Schema.array(String).role('table').default([]).description('用户黑名单'),
      }).description('黑名单'),
      maxUrlsPerMessage: Schema.number().default(3).min(1).max(10).description('单条消息最大解析数'),
    }),
  }).description('自动解析'),

  // ── 合并转发 ──────────────────────────────────────────
  Schema.object({
    forward: Schema.object({
      enabled: Schema.boolean().default(true).description('启用（OneBot 合并转发）'),
      nickname: Schema.string().default('内容解析').description('转发昵称'),
      includeMusic: Schema.boolean().default(true).description('抖音附带背景音乐'),
      autoMergeForward: Schema.boolean().default(true).description('长文/多图自动合并'),
      longTextThreshold: Schema.number().default(260).min(80).max(2_000).description('触发合并的文本长度'),
      imageMergeThreshold: Schema.number().default(2).min(1).max(20).description('触发合并的图片数'),
      maxForwardImages: Schema.number().default(4).min(1).max(10).description('合并转发最大图片数'),
      textChunkSize: Schema.number().default(280).min(80).max(1_000).description('文本分片长度'),
      maxForwardNodes: Schema.number().default(25).min(5).max(80).description('最大转发节点数'),
    }),
  }).description('合并转发'),

  // ── ChatLuna 工具 ─────────────────────────────────────
  Schema.object({
    tool: Schema.object({
      enabled: Schema.boolean().default(true).description('注册工具'),
      name: Schema.string().default('read_social_media').description('工具名称'),
      description: Schema.string().default('读取抖音/小红书/B站/Twitter(X) 链接并返回结构化内容。').description('工具描述'),
    }),
  }).description('ChatLuna 工具'),
])

export interface MigrationResult {
  config: Config
  usedLegacyKeys: string[]
}

export function migrateConfig(rawConfig: unknown): MigrationResult {
  const source = (rawConfig && typeof rawConfig === 'object') ? rawConfig as Record<string, any> : {}
  const migrated: Record<string, any> = {
    ...source,
    network: isRecord(source.network) ? { ...source.network } : {},
    media: isRecord(source.media)
      ? {
          ...source.media,
          videoCache: isRecord(source.media.videoCache) ? { ...source.media.videoCache } : {},
        }
      : { videoCache: {} },
    autoParse: isRecord(source.autoParse)
      ? {
          ...source.autoParse,
          blacklist: isRecord(source.autoParse.blacklist) ? { ...source.autoParse.blacklist } : {},
        }
      : { blacklist: {} },
    tool: isRecord(source.tool) ? { ...source.tool } : {},
    platforms: isRecord(source.platforms)
      ? {
          ...source.platforms,
          douyin: isRecord(source.platforms.douyin)
            ? {
                ...source.platforms.douyin,
                api: isRecord(source.platforms.douyin.api) ? { ...source.platforms.douyin.api } : {},
              }
            : { api: {} },
          xiaohongshu: isRecord(source.platforms.xiaohongshu) ? { ...source.platforms.xiaohongshu } : {},
          bilibili: isRecord(source.platforms.bilibili) ? { ...source.platforms.bilibili } : {},
          twitter: isRecord(source.platforms.twitter)
            ? {
                ...source.platforms.twitter,
                grok: isRecord(source.platforms.twitter.grok) ? { ...source.platforms.twitter.grok } : {},
                routing: isRecord(source.platforms.twitter.routing) ? { ...source.platforms.twitter.routing } : {},
                translation: isRecord(source.platforms.twitter.translation) ? { ...source.platforms.twitter.translation } : {},
              }
            : { grok: {}, routing: {}, translation: {} },
        }
      : {
          douyin: { api: {} },
          xiaohongshu: {},
          bilibili: {},
          twitter: { grok: {}, routing: {}, translation: {} },
        },
  }

  const usedLegacyKeys: string[] = []

  moveLegacy(source, migrated, usedLegacyKeys, 'timeoutMs', 'network.timeoutMs')
  moveLegacy(source, migrated, usedLegacyKeys, 'cooldownMs', 'network.cooldownMs')
  moveLegacy(source, migrated, usedLegacyKeys, 'maxMediaBytes', 'media.maxBytes')
  moveLegacy(source, migrated, usedLegacyKeys, 'maxVideoDownloadBytes', 'media.maxVideoBytes')
  moveLegacy(source, migrated, usedLegacyKeys, 'maxVideoDurationSec', 'media.maxDurationSec')
  moveLegacy(source, migrated, usedLegacyKeys, 'sendMode', 'media.sendMode')
  moveLegacy(source, migrated, usedLegacyKeys, 'videoSendMode', 'media.videoSendMode')
  moveLegacy(source, migrated, usedLegacyKeys, 'fallbackToUrlOnError', 'media.fallbackToUrlOnError')
  moveLegacy(source, migrated, usedLegacyKeys, 'onlyGroup', 'autoParse.onlyGroup')
  moveLegacy(source, migrated, usedLegacyKeys, 'autoParse.blockedGuilds', 'autoParse.blacklist.guilds')
  moveLegacy(source, migrated, usedLegacyKeys, 'autoParse.blockedUsers', 'autoParse.blacklist.users')
  moveLegacy(source, migrated, usedLegacyKeys, 'douyin.autoParseBlockedGuilds', 'platforms.douyin.autoParseBlockedGuilds')
  moveLegacy(source, migrated, usedLegacyKeys, 'xiaohongshu.autoParseBlockedGuilds', 'platforms.xiaohongshu.autoParseBlockedGuilds')
  moveLegacy(source, migrated, usedLegacyKeys, 'bilibili.autoParseBlockedGuilds', 'platforms.bilibili.autoParseBlockedGuilds')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitter.autoParseBlockedGuilds', 'platforms.twitter.autoParseBlockedGuilds')
  moveLegacy(source, migrated, usedLegacyKeys, 'douyin.enabled', 'platforms.douyin.enabled')
  moveLegacy(source, migrated, usedLegacyKeys, 'douyin.apiBaseUrl', 'platforms.douyin.api.baseUrl')
  moveLegacy(source, migrated, usedLegacyKeys, 'douyin.fallbackApiBaseUrls', 'platforms.douyin.api.fallbackUrls')
  moveLegacy(source, migrated, usedLegacyKeys, 'douyin.maxImages', 'platforms.douyin.maxImages')
  moveLegacy(source, migrated, usedLegacyKeys, 'xiaohongshu.enabled', 'platforms.xiaohongshu.enabled')
  moveLegacy(source, migrated, usedLegacyKeys, 'xiaohongshu.userAgent', 'platforms.xiaohongshu.userAgent')
  moveLegacy(source, migrated, usedLegacyKeys, 'xiaohongshu.maxRetries', 'platforms.xiaohongshu.maxRetries')
  moveLegacy(source, migrated, usedLegacyKeys, 'xiaohongshu.maxImages', 'platforms.xiaohongshu.maxImages')
  moveLegacy(source, migrated, usedLegacyKeys, 'bilibili.enabled', 'platforms.bilibili.enabled')
  moveLegacy(source, migrated, usedLegacyKeys, 'bilibili.fetchVideo', 'platforms.bilibili.fetchVideo')
  moveLegacy(source, migrated, usedLegacyKeys, 'bilibili.maxDescLength', 'platforms.bilibili.maxDescLength')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitter.enabled', 'platforms.twitter.enabled')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitter.maxImages', 'platforms.twitter.maxImages')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterGrok.enabled', 'platforms.twitter.grok.enabled')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterGrok.baseUrl', 'platforms.twitter.grok.baseUrl')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterGrok.apiKey', 'platforms.twitter.grok.apiKey')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterGrok.model', 'platforms.twitter.grok.model')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterGrok.timeoutMs', 'platforms.twitter.grok.timeoutMs')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterRouting.textProviderOrder', 'platforms.twitter.routing.textProviderOrder')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterRouting.imageProviderOrder', 'platforms.twitter.routing.imageProviderOrder')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterRouting.videoProviderOrder', 'platforms.twitter.routing.videoProviderOrder')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterRouting.translationProviderOrder', 'platforms.twitter.routing.translationProviderOrder')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterTranslation.enabled', 'platforms.twitter.translation.enabled')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterTranslation.targetLanguage', 'platforms.twitter.translation.targetLanguage')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterTranslation.maxChars', 'platforms.twitter.translation.maxChars')
  moveLegacy(source, migrated, usedLegacyKeys, 'twitterTranslation.showOriginal', 'platforms.twitter.translation.showOriginal')
  propagateLegacyGuildBlacklist(source, migrated)

  if (!hasPath(migrated, 'media.videoSendMode')) {
    const legacySendMode = getPath(migrated, 'media.sendMode')
    migrated.media.videoSendMode = legacySendMode === 'url' ? 'url' : 'base64'
  }

  return {
    config: migrated as Config,
    usedLegacyKeys: Array.from(new Set(usedLegacyKeys)),
  }
}

function moveLegacy(
  source: Record<string, any>,
  target: Record<string, any>,
  usedLegacyKeys: string[],
  legacyPath: string,
  nextPath: string,
): void {
  if (!hasPath(source, legacyPath)) {
    return
  }

  const value = getPath(source, legacyPath)
  setPath(target, nextPath, value)
  usedLegacyKeys.push(legacyPath)
}

function propagateLegacyGuildBlacklist(source: Record<string, any>, target: Record<string, any>): void {
  const legacyGuilds = normalizeStringArray(
    hasPath(source, 'autoParse.blacklist.guilds')
      ? getPath(source, 'autoParse.blacklist.guilds')
      : hasPath(source, 'autoParse.blockedGuilds')
        ? getPath(source, 'autoParse.blockedGuilds')
        : [],
  )

  if (!legacyGuilds.length) {
    return
  }

  const platformKeys = ['douyin', 'xiaohongshu', 'bilibili', 'twitter'] as const
  for (const platformKey of platformKeys) {
    const sourceHasScopedConfig = hasPath(source, `platforms.${platformKey}.autoParseBlockedGuilds`)
      || hasPath(source, `${platformKey}.autoParseBlockedGuilds`)
    if (sourceHasScopedConfig) {
      continue
    }

    const current = normalizeStringArray(getPath(target, `platforms.${platformKey}.autoParseBlockedGuilds`))
    if (current.length > 0) {
      continue
    }

    setPath(target, `platforms.${platformKey}.autoParseBlockedGuilds`, [...legacyGuilds])
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)

  return Array.from(new Set(normalized))
}

function hasPath(source: Record<string, any>, path: string): boolean {
  const keys = path.split('.')
  let cursor: any = source
  for (const key of keys) {
    if (!isRecord(cursor)) {
      return false
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) {
      return false
    }
    cursor = cursor[key]
  }
  return true
}

function getPath(source: Record<string, any>, path: string): any {
  const keys = path.split('.')
  let cursor: any = source
  for (const key of keys) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) {
      return undefined
    }
    cursor = cursor[key]
  }
  return cursor
}

function setPath(target: Record<string, any>, path: string, value: any): void {
  const keys = path.split('.')
  let cursor: Record<string, any> = target

  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    const current = cursor[key]
    if (!isRecord(current)) {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }

  cursor[keys[keys.length - 1]] = value
}
