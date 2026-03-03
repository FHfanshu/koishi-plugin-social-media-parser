# koishi-plugin-social-media-parser

抖音 + 小红书 + Bilibili 三合一解析插件，支持自动解析、手动命令和 ChatLuna 工具调用。

## 功能

- 自动解析抖音/小红书/Bilibili 链接（支持 guild 黑名单）
- 手动命令：`parse <url>`
- ChatLuna 工具：`parse_social_media`
- 自动解析后可静默注入 ChatLuna 上下文
- 媒体注入链路支持图片压缩、短视频压缩、长视频抽帧+保留音频
- 长文本/多图自动合并转发，减少刷屏
- 抖音解析使用 Douyin_TikTok_Download_API（`/api/hybrid/video_data`）

## 配置要点

- `douyin.apiBaseUrl`: Douyin_TikTok_Download_API 地址（默认 `https://api.douyin.wtf`）
- `douyin.fallbackApiBaseUrls`: 备用抖音 API 地址列表（主 API 失败时按顺序回退）
- `autoParse.blockedGuilds`: 自动解析群黑名单
- `autoParse.blockedUsers`: 自动解析用户黑名单
- `autoParse.injectContext`: 自动解析后注入上下文
- `autoParse.mediaInject.*`: 媒体注入参数（分辨率、时长、抽帧等）
- `forward.autoMergeForward`: 长文本/多图自动合并转发

## 开发

```bash
yarn workspace koishi-plugin-social-media-parser build
```

## 许可证

MIT
