import { Schema } from 'koishi'

import type { SendMode, ToolContentLevel } from './types'

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

export interface DouyinConfig {
  enabled: boolean
  parseMode: 'video-only' | 'video+images'
  notifyOnSkip: boolean
  maxImages: number
  puppeteerFallback: boolean
  puppeteerTimeoutMs: number
}

export interface XiaohongshuConfig {
  enabled: boolean
  userAgent: string
  maxRetries: number
  maxImages: number
}

export interface BilibiliConfig {
  enabled: boolean
  fetchVideo: boolean
  maxDescLength: number
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
  guilds: string[]
  users: string[]
  maxUrlsPerMessage: number
  injectContext: boolean
  injectMedia: boolean
  contextMaxChars: number
  mediaInject: MediaInjectConfig
}

export interface ToolConfig {
  enabled: boolean
  toolName: string
  toolDescription: string
  contentLevel: ToolContentLevel
  injectContext: boolean
  injectMedia: boolean
  mediaInject: MediaInjectConfig
}

export interface Config {
  enabled: boolean
  onlyGroup: boolean
  cooldownMs: number
  timeoutMs: number
  maxMediaBytes: number
  sendMode: SendMode
  fallbackToUrlOnError: boolean
  debug: boolean
  douyin: DouyinConfig
  xiaohongshu: XiaohongshuConfig
  bilibili: BilibiliConfig
  forward: ForwardConfig
  autoParse: AutoParseConfig
  tool: ToolConfig
}

const MediaInjectSchema: Schema<MediaInjectConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用媒体注入'),
  maxImages: Schema.number().default(3).min(0).max(12).description('最多注入图片数量'),
  imageMaxEdgePx: Schema.number().default(800).min(256).max(1920).description('图片压缩最大边长（像素）'),
  imageQuality: Schema.number().default(75).min(35).max(95).description('图片 JPEG 质量（1-100）'),
  videoEnabled: Schema.boolean().default(true).description('启用视频注入'),
  videoResolution: Schema.union([
    Schema.const(480).description('480p（更省流量）'),
    Schema.const(720).description('720p（更清晰）')
  ]).default(480).description('视频压缩分辨率高度'),
  videoMaxDurationSec: Schema.number().default(60).min(10).max(300).description('短视频最大时长（秒）'),
  longVideoFrameIntervalSec: Schema.number().default(5).min(1).max(30).description('长视频抽帧间隔（秒）'),
  longVideoMaxFrames: Schema.number().default(12).min(1).max(60).description('长视频最多注入帧数'),
  keepAudio: Schema.boolean().default(true).description('长视频抽帧模式保留音频注入（不压缩）'),
  maxTotalBytes: Schema.number().default(10 * 1024 * 1024).description('单次注入媒体总大小上限（bytes）'),
  ffmpegTimeoutMs: Schema.number().default(30_000).min(3_000).max(180_000).description('ffmpeg 处理超时（毫秒）'),
})

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('启用插件'),
    onlyGroup: Schema.boolean().default(true).description('仅在群聊触发自动解析'),
    cooldownMs: Schema.number().default(8_000).description('同一链接冷却时间（毫秒）'),
    timeoutMs: Schema.number().default(15_000).description('网络请求超时（毫秒）'),
    maxMediaBytes: Schema.number().default(15 * 1024 * 1024).description('消息发送时单个媒体最大下载大小（bytes）'),
    sendMode: Schema.union([
      Schema.const('base64').description('下载后转 base64 发送（更稳定）'),
      Schema.const('url').description('直接发送 URL（更省流量）')
    ]).default('base64').description('消息发送模式'),
    fallbackToUrlOnError: Schema.boolean().default(true).description('base64 发送失败回退到 URL'),
    debug: Schema.boolean().default(false).description('输出调试日志'),
  }).description('基础设置'),
  Schema.object({
    douyin: Schema.object({
      enabled: Schema.boolean().default(true).description('启用抖音解析'),
      parseMode: Schema.union(['video-only', 'video+images']).default('video-only').description('解析模式'),
      notifyOnSkip: Schema.boolean().default(true).description('仅视频模式遇到图文时提示'),
      maxImages: Schema.number().default(9).min(1).max(20).description('图文最多保留图片数量'),
      puppeteerFallback: Schema.boolean().default(true).description('接口失败时启用 Puppeteer 回退'),
      puppeteerTimeoutMs: Schema.number().default(20_000).description('Puppeteer 回退超时（毫秒）'),
    }).description('抖音解析设置'),
    xiaohongshu: Schema.object({
      enabled: Schema.boolean().default(true).description('启用小红书解析'),
      userAgent: Schema.string().default(DEFAULT_USER_AGENT).description('抓取页面使用的 User-Agent'),
      maxRetries: Schema.number().default(3).min(1).max(6).description('抓取失败重试次数'),
      maxImages: Schema.number().default(20).min(1).max(40).description('图文最多保留图片数量'),
    }).description('小红书解析设置'),
    bilibili: Schema.object({
      enabled: Schema.boolean().default(true).description('启用 Bilibili 解析'),
      fetchVideo: Schema.boolean().default(true).description('尝试获取视频直链（第三方 API，可能不稳定）'),
      maxDescLength: Schema.number().default(100).min(20).max(500).description('视频简介最大字符数'),
    }).description('Bilibili 解析设置'),
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
  }).description('平台解析设置'),
  Schema.object({
    autoParse: Schema.object({
      enabled: Schema.boolean().default(true).description('启用自动解析中间件'),
      guilds: Schema.array(String).role('table').default([]).description('自动解析 guild 白名单（支持 platform:guildId）'),
      users: Schema.array(String).role('table').default([]).description('自动解析 user 白名单（支持 platform:userId）'),
      maxUrlsPerMessage: Schema.number().default(3).min(1).max(10).description('单条消息最多解析链接数量'),
      injectContext: Schema.boolean().default(true).description('自动解析后静默注入 ChatLuna 上下文'),
      injectMedia: Schema.boolean().default(true).description('自动解析时注入压缩媒体（图片/视频）'),
      contextMaxChars: Schema.number().default(500).min(100).max(4_000).description('注入摘要正文最大字符数'),
      mediaInject: MediaInjectSchema,
    }).description('自动解析与上下文注入'),
    tool: Schema.object({
      enabled: Schema.boolean().default(true).description('注册 ChatLuna 工具'),
      toolName: Schema.string().default('parse_social_media').description('工具名称'),
      toolDescription: Schema.string().default('解析抖音、小红书或 Bilibili 链接并返回结构化内容摘要。').description('工具描述'),
      contentLevel: Schema.union([
        Schema.const('summary').description('返回摘要（推荐）'),
        Schema.const('full').description('返回尽可能完整的正文与媒体列表')
      ]).default('summary').description('工具返回内容级别'),
      injectContext: Schema.boolean().default(true).description('工具调用后注入上下文（仅同会话）'),
      injectMedia: Schema.boolean().default(true).description('工具调用时注入压缩媒体（图片/视频）'),
      mediaInject: MediaInjectSchema,
    }).description('ChatLuna 工具设置'),
  }).description('自动解析与工具设置'),
])
