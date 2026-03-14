import path from 'node:path'

import type { Context, Logger } from 'koishi'

import { Config, migrateConfig } from './config'
import type { Config as PluginConfig } from './config'
import { registerParseCommand } from './command'
import { registerAutoParseMiddleware } from './middleware'
import { setFfmpegPaths } from './utils/compress'

type FfmpegServiceLike = {
  executable?: string
  path?: string
  ffmpegPath?: string
  ffprobePath?: string
  ffprobe?: string
}

type ConsoleEntryLike = string[] | {
  dev: string
  prod: string
}

type ConsoleCtxLike = Context & {
  console?: {
    addEntry?: (entry: ConsoleEntryLike) => void
  }
}

export const name = 'social-media-parser'

export const inject = {
  required: ['http'],
  optional: ['chatluna', 'chatluna_storage', 'ffmpeg', 'console'],
} as const

export const usage = `
## Social Media Parser

抖音 + 小红书 + 哔哩哔哩 + Twitter(X) 解析插件，支持：
- 自动解析（guild 黑名单）
- 手动命令：\`parse <url>\`

### 依赖项

- 必需：\`http\`（用于 API 请求与媒体下载）
- 可选：\`chatluna_storage\`（媒体持久化存储，避免 base64 data URI）
- 可选：\`ffmpeg\`（优先使用 Koishi 提供的 ffmpeg/ffprobe 路径）

### 支持平台

- 抖音：\`v.douyin.com\` / \`www.douyin.com\` / \`www.iesdouyin.com\`
- 小红书：\`xiaohongshu.com\` / \`xhslink.com\`
- 哔哩哔哩：\`bilibili.com\` / \`b23.tv\` / \`bili22.cn\` / \`bili23.cn\` / \`bili33.cn\` / \`bili2233.cn\`
- Twitter/X：\`x.com\` / \`twitter.com\` / \`t.co\` / \`fxtwitter.com\` / \`vxtwitter.com\`

### 自动解析

- 自动解析支持平台级群聊黑名单：\`platforms.<platform>.autoParseBlockedGuilds\`。
- 自动解析用户黑名单：\`autoParse.blacklist.users\`。
- 自动解析命中后发送解析结果。

### 注意事项

- NapCat 等 OneBot 协议端在发送合并转发消息时可能出现超时，导致消息发送失败。若频繁遇到此问题，可尝试关闭 \`forward.autoMergeForward\` 或调低 \`forward.maxForwardNodes\`。
`

export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger('social-media-parser')

  if (!config || typeof config !== 'object') {
    logger.error('插件配置为空或无效，已跳过加载。')
    return
  }

  const { config: resolvedConfig, usedLegacyKeys } = migrateConfig(config)

  if (usedLegacyKeys.length > 0) {
    logger.warn(`检测到旧版配置键，已自动迁移: ${usedLegacyKeys.join(', ')}`)
  }

  const cooldownMap = new Map<string, number>()

  // Get ffmpeg paths from Koishi ffmpeg service and configure compress module
  // This avoids polluting process.env which can affect other plugins in the same process
  // Note: ffmpeg-path initializes asynchronously, so we inject it to ensure it's ready
  ctx.inject(['ffmpeg'], (innerCtx) => {
    const ffmpegService = (innerCtx as Context & { ffmpeg?: FfmpegServiceLike }).ffmpeg
    const ffmpegPath = ffmpegService?.executable || ffmpegService?.path || ffmpegService?.ffmpegPath || null
    const ffprobePath =
      ffmpegService?.ffprobePath || ffmpegService?.ffprobe || deriveFfprobePathFromFfmpeg(ffmpegPath) || null
    if (ffmpegPath) {
      ctx.logger.warn(`[social-media-parser] using ffmpeg: ${ffmpegPath}`)
    }
    setFfmpegPaths(ffmpegPath, ffprobePath)
  })

  // Fallback: also try in ready event in case inject didn't work (ffmpeg is optional)
  ctx.on('ready', () => {
    const ffmpegService = (ctx as Context & { ffmpeg?: FfmpegServiceLike }).ffmpeg
    if (ffmpegService?.executable) {
      const ffmpegPath = ffmpegService.executable
      const ffprobePath =
        ffmpegService?.ffprobePath || ffmpegService?.ffprobe || deriveFfprobePathFromFfmpeg(ffmpegPath) || null
      ctx.logger.warn(`[social-media-parser] ready: using ffmpeg: ${ffmpegPath}`)
      setFfmpegPaths(ffmpegPath, ffprobePath)
    }
  })

  registerParseCommand(ctx, resolvedConfig)
  registerAutoParseMiddleware(ctx, resolvedConfig, cooldownMap)
  ctx.inject(['console'], (innerCtx) => {
    const packageBase = path.resolve(ctx.baseDir, 'node_modules/koishi-plugin-social-media-parser')
    const entry = process.env.KOISHI_BASE
      ? [`${process.env.KOISHI_BASE}/dist/index.js`]
      : process.env.KOISHI_ENV === 'browser'
        ? [path.resolve(__dirname, '../client/index.ts')]
        : {
            dev: path.resolve(packageBase, 'client/index.ts'),
            prod: path.resolve(packageBase, 'dist'),
          }

    ;(innerCtx as ConsoleCtxLike).console?.addEntry?.(entry)
  })

  logger.info('social-media-parser 插件已加载')
}

function deriveFfprobePathFromFfmpeg(ffmpegPath: unknown): string | null {
  if (typeof ffmpegPath !== 'string' || !ffmpegPath) {
    return null
  }

  if (!ffmpegPath.includes('/')) {
    if (ffmpegPath === 'ffmpeg') {
      return 'ffprobe'
    }
    return null
  }

  const dir = path.dirname(ffmpegPath)
  const ext = path.extname(ffmpegPath)
  const base = path.basename(ffmpegPath, ext)
  const probeBase = base.replace(/ffmpeg/i, 'ffprobe')
  if (probeBase === base) {
    return null
  }

  return path.join(dir, `${probeBase}${ext}`)
}

export { Config }
