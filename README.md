# koishi-plugin-social-media-parser

抖音 + 小红书 + Bilibili + Twitter(X) 解析插件，支持自动解析、手动命令和 ChatLuna 工具调用。

## 功能

- 自动解析抖音/小红书/Bilibili/Twitter(X) 链接（支持群/用户黑名单）
- 手动命令：`parse <url>`
- ChatLuna 工具：`parse_social_media`
- 自动解析后可静默注入 ChatLuna 上下文
- 媒体注入链路支持图片压缩、短视频压缩、长视频抽帧+保留音频
- 长文本/多图自动合并转发，减少刷屏
- 抖音解析使用 Douyin_TikTok_Download_API（`/api/hybrid/video_data`）
- Twitter/X 解析支持 fxtwitter 与 Grok 路由组合

默认行为：

- `autoParse.injectContext=false`（默认不注入 ChatLuna 上下文）
- `tool.enabled=false`（默认不注册 `parse_social_media` 工具）

## 配置要点

- `platforms.douyin.api.baseUrl`: 抖音 API 主地址（默认 `https://api.douyin.wtf`）
- `platforms.douyin.api.fallbackUrls`: 抖音 API 备用地址列表（按顺序回退）
- `platforms.twitter.enabled`: 启用 Twitter/X 解析（fxtwitter/Grok 路由）
- `platforms.twitter.grok.*`: Grok 解析来源开关、模型和超时（地址与密钥默认复用 ChatLuna 平台配置）
- `platforms.twitter.routing.*`: 文本/图片/视频/翻译 provider 优先级（`grok` 与 `fxtwitter`）
- `media.videoSendMode`: 视频发送模式（`storage` / `base64` / `url`）
- `autoParse.blacklist.guilds`: 自动解析群黑名单
- `autoParse.blacklist.users`: 自动解析用户黑名单
- `autoParse.injectContext`: 自动解析后注入上下文（默认关闭）
- `forward.autoMergeForward`: 长文本/多图自动合并转发

## 开发

```bash
yarn workspace koishi-plugin-social-media-parser build
```

## 许可证

MIT
