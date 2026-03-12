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

export interface MediaConfig {
  maxBytes: number
  maxVideoBytes: number
  maxDurationSec: number
  sendMode: SendMode
  videoSendMode: VideoSendMode
  fallbackToUrlOnError: boolean
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
}

export interface BilibiliConfig {
  enabled: boolean
  fetchVideo: boolean
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
  textChunkSize: number
  maxForwardNodes: number
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
  autoParse: AutoParseConfig
  debug: boolean
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
  ffmpegTimeoutMs: 30_000,
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    network: Schema.object({
      cooldownMs: Schema.number().default(8_000).description('同一链接冷却时间（毫秒）'),
      timeoutMs: Schema.number().default(15_000).description('网络请求超时（毫秒）'),
    }).description('网络设置'),
    media: Schema.object({
      maxBytes: Schema.number().default(15 * 1024 * 1024).description('消息发送时单个媒体最大下载大小（bytes）'),
      maxVideoBytes: Schema.number().default(512 * 1024 * 1024).min(8 * 1024 * 1024).max(2 * 1024 * 1024 * 1024).description('视频下载最大大小（bytes，用于时长探测与视频处理；建议大于 maxBytes）'),
      maxDurationSec: Schema.number().default(1800).min(60).max(7200).description('视频最大时长（秒），超出则跳过解析。默认 1800 秒（30 分钟）'),
      sendMode: Schema.union([
        Schema.const('base64').description('下载后转 base64 发送（更稳定）'),
        Schema.const('storage').description('下载后优先交给 chatluna storage service 托管；无 storage 时回退 base64'),
        Schema.const('url').description('直接发送 URL（更省流量）')
      ]).default('base64').description('消息发送模式'),
      videoSendMode: Schema.union([
        Schema.const('storage').description('下载视频后优先交给 chatluna storage service 托管；无 storage 时回退 base64'),
        Schema.const('base64').description('下载视频后使用 base64:// 发送（OneBot 更稳）'),
        Schema.const('url').description('直接发送视频直链（最省流量，但平台兼容性最差）')
      ]).default('base64').description('视频发送模式'),
      fallbackToUrlOnError: Schema.boolean().default(true).description('下载/发送失败时允许回退到直链（OneBot 下的非 url 视频模式不会回退）'),
    }).description('媒体与发送设置'),
  }).description('网络与媒体设置'),
  Schema.object({
    platforms: Schema.object({
      douyin: Schema.object({
        enabled: Schema.boolean().default(true).description('启用抖音解析'),
        api: Schema.object({
          baseUrl: Schema.string().default('https://api.douyin.wtf').description('Douyin_TikTok_Download_API 地址'),
          fallbackUrls: Schema.array(String).role('table').default([]).description('抖音解析备用 API 地址列表（按顺序回退）'),
        }).description('抖音 API 设置'),
        maxImages: Schema.number().default(9).min(1).max(20).description('图文最多保留图片数量'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析 guild 黑名单（仅抖音，支持 platform:guildId）'),
      }).description('抖音解析设置'),
      xiaohongshu: Schema.object({
        enabled: Schema.boolean().default(true).description('启用小红书解析'),
        userAgent: Schema.string().default(DEFAULT_USER_AGENT).description('抓取页面使用的 User-Agent'),
        maxRetries: Schema.number().default(3).min(1).max(6).description('抓取失败重试次数'),
        maxImages: Schema.number().default(20).min(1).max(40).description('图文最多保留图片数量'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析 guild 黑名单（仅小红书，支持 platform:guildId）'),
      }).description('小红书解析设置'),
      bilibili: Schema.object({
        enabled: Schema.boolean().default(true).description('启用 Bilibili 解析'),
        fetchVideo: Schema.boolean().default(true).description('尝试获取视频直链（第三方 API，可能不稳定）'),
        maxDescLength: Schema.number().default(100).min(20).max(500).description('视频简介最大字符数'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析 guild 黑名单（仅 Bilibili，支持 platform:guildId）'),
      }).description('Bilibili 解析设置'),
      twitter: Schema.object({
        enabled: Schema.boolean().default(false).description('启用 Twitter/X 解析（FxTwitter/Grok）'),
        maxImages: Schema.number().default(9).min(1).max(20).description('图片推文最多保留图片数量'),
        grok: Schema.object({
          enabled: Schema.boolean().default(false).description('启用 Grok 作为 Twitter/X 文本与图片解析来源'),
          model: Schema.dynamic('model').default('grok-4.1-fast').description('Grok 模型（使用 ChatLuna 模型下拉）'),
          timeoutMs: Schema.number().default(35_000).min(3_000).max(180_000).description('Grok 请求超时（毫秒）'),
        }).description('Twitter/X Grok 设置'),
        routing: Schema.object({
          textProviderOrder: Schema.string().default('fxtwitter,grok').description('文本解析优先级（逗号分隔：fxtwitter,grok）'),
          imageProviderOrder: Schema.string().default('fxtwitter,grok').description('图片解析优先级（逗号分隔：fxtwitter,grok）'),
          videoProviderOrder: Schema.string().default('fxtwitter,grok').description('视频解析优先级（逗号分隔：fxtwitter,grok）'),
          translationProviderOrder: Schema.string().default('grok').description('翻译优先级（当前仅支持：grok）'),
        }).description('Twitter/X 路由优先级设置'),
        translation: Schema.object({
          enabled: Schema.boolean().default(false).description('启用 Twitter/X 正文翻译'),
          targetLanguage: Schema.string().default('zh-CN').description('翻译目标语言（如 zh-CN）'),
          maxChars: Schema.number().default(1200).min(80).max(10_000).description('翻译前截断最大字符数'),
          showOriginal: Schema.boolean().default(true).description('发送时保留原文（关闭后仅展示译文）'),
        }).description('Twitter/X 翻译设置'),
        autoParseBlockedGuilds: Schema.array(String).role('table').default([]).description('自动解析 guild 黑名单（仅 Twitter/X，支持 platform:guildId）'),
      }).description('Twitter/X 解析设置'),
    }),
  }).description('平台设置'),
  Schema.object({
    autoParse: Schema.object({
      enabled: Schema.boolean().default(true).description('启用自动解析中间件'),
      onlyGroup: Schema.boolean().default(true).description('仅在群聊触发自动解析'),
      blacklist: Schema.object({
        guilds: Schema.array(String).role('table').default([]).hidden().description('兼容旧配置：自动解析全局 guild 黑名单（建议改用各平台 autoParseBlockedGuilds）'),
        users: Schema.array(String).role('table').default([]).description('自动解析 user 黑名单（支持 platform:userId）'),
      }).description('自动解析黑名单'),
      maxUrlsPerMessage: Schema.number().default(3).min(1).max(10).description('单条消息最多解析链接数量'),
    }).description('自动解析设置'),
    forward: Schema.object({
      enabled: Schema.boolean().default(true).description('图片内容优先使用合并转发（OneBot）'),
      nickname: Schema.string().default('内容解析').description('合并转发显示昵称'),
      includeMusic: Schema.boolean().default(true).description('抖音图文转发时附带背景音乐'),
      autoMergeForward: Schema.boolean().default(true).description('长文本/多图自动合并转发，减少刷屏'),
      longTextThreshold: Schema.number().default(260).min(80).max(2_000).description('触发自动合并转发的文本长度阈值'),
      imageMergeThreshold: Schema.number().default(2).min(1).max(20).description('触发自动合并转发的图片数量阈值'),
      textChunkSize: Schema.number().default(280).min(80).max(1_000).description('合并转发模式下文本分片长度'),
      maxForwardNodes: Schema.number().default(25).min(5).max(80).description('单次合并转发最多节点数'),
    }).description('转发消息设置'),
  }).description('自动解析与转发设置'),
  Schema.object({
    debug: Schema.boolean().default(false).description('输出调试日志'),
  }).description('调试设置'),
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
    media: isRecord(source.media) ? { ...source.media } : {},
    autoParse: isRecord(source.autoParse)
      ? {
          ...source.autoParse,
          blacklist: isRecord(source.autoParse.blacklist) ? { ...source.autoParse.blacklist } : {},
        }
      : { blacklist: {} },
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
