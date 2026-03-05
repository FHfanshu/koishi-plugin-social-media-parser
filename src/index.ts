import path from 'node:path'

import type { Context } from 'koishi'

import { Config } from './config'
import type { Config as PluginConfig } from './config'
import { registerParseCommand } from './command'
import { registerAutoParseMiddleware } from './middleware'
import { registerParseUrlTool } from './tools/parse-url-tool'

export const name = 'social-media-parser'

export const inject = {
  required: ['http'],
  optional: ['chatluna', 'chatluna_character', 'chatluna_storage', 'console'],
} as const

export const usage = `
## Social Media Parser

抖音 + 小红书 + 哔哩哔哩 + Twitter(X) + YouTube 五合一解析插件，支持：
- 自动解析（guild 黑名单）
- 手动命令：\`parse <url>\`
- ChatLuna 工具：\`parse_social_media\`

### 依赖项

- 必需：\`http\`（用于 API 请求与媒体下载）
- 可选：\`chatluna\`（注册 \`parse_social_media\` 工具）
- 可选：\`chatluna_character\`（角色相关广播能力，可选）
- 可选：\`chatluna_storage\`（媒体持久化存储，避免 base64 data URI）

### 支持平台

- 抖音：\`v.douyin.com\` / \`www.douyin.com\` / \`www.iesdouyin.com\`
- 小红书：\`xiaohongshu.com\` / \`xhslink.com\`
- 哔哩哔哩：\`bilibili.com\` / \`b23.tv\` / \`bili22.cn\` / \`bili23.cn\` / \`bili33.cn\` / \`bili2233.cn\`
- Twitter/X：\`x.com\` / \`twitter.com\` / \`t.co\` / \`fxtwitter.com\` / \`vxtwitter.com\`
- YouTube：\`youtube.com\` / \`youtu.be\` / \`m.youtube.com\` / \`music.youtube.com\`

### 自动解析与上下文注入

- 自动解析受 \`autoParse.blockedGuilds\` / \`autoParse.blockedUsers\` 黑名单限制。
- 自动解析命中后会发送媒体到群聊，并可静默注入 ChatLuna 上下文。
- 默认不主动触发角色回复（仅作为后续对话上下文）。

### 视频处理策略

- 短视频（<= videoMaxDurationSec）压缩后注入。
- 长视频（> videoMaxDurationSec）按间隔抽帧注入，并可保留音频。
`

export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger('social-media-parser')

  if (!config || typeof config !== 'object') {
    logger.error('插件配置为空或无效，已跳过加载。')
    return
  }

  const cooldownMap = new Map<string, number>()

  registerParseCommand(ctx, config)
  registerAutoParseMiddleware(ctx, config, cooldownMap)

  ctx.inject(['chatluna'], (innerCtx) => {
    registerParseUrlTool(innerCtx as any, config)
  })

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

    ;(innerCtx as any).console?.addEntry?.(entry as any)
  })

  logger.info('social-media-parser 插件已加载')
}

export { Config }
