# koishi-plugin-social-media-parser

抖音 + 小红书 + Bilibili + Twitter(X) + YouTube 五合一解析插件，支持自动解析、手动命令和 ChatLuna 工具调用。

## 功能

- 自动解析抖音/小红书/Bilibili/Twitter(X)/YouTube 链接（支持 guild 黑名单）
- 手动命令：`parse <url>`
- ChatLuna 工具：`parse_social_media`
- 自动解析后可静默注入 ChatLuna 上下文
- 媒体注入链路支持图片压缩、短视频压缩、长视频抽帧+保留音频
- 长文本/多图自动合并转发，减少刷屏
- 抖音解析使用 Douyin_TikTok_Download_API（`/api/hybrid/video_data`）

## 配置要点

- `douyin.apiBaseUrl`: Douyin_TikTok_Download_API 地址（默认 `https://api.douyin.wtf`）
- `douyin.fallbackApiBaseUrls`: 备用抖音 API 地址列表（主 API 失败时按顺序回退）
- `douyin.rapidApiKey`: RapidAPI Key（可选，常规 API 全失败时启用 RapidAPI 回退）
- `douyin.rapidApiHost`: RapidAPI Host（例如 `xxx.p.rapidapi.com`）
- `douyin.rapidApiEndpointPath`: RapidAPI 端点路径（默认 `/api/hybrid/video_data`）
- `douyin.rapidApiUrlParamKey`: RapidAPI URL 参数名（默认 `url`）
- `youtube.enabled`: 启用 YouTube 解析（默认关闭）
- `youtube.rapidApiKey`: Snap Video RapidAPI Key（`x-rapidapi-key`）
- `youtube.rapidApiHost`: Snap Video RapidAPI Host（默认 `snap-video3.p.rapidapi.com`）
- `youtube.endpointPath`: Snap Video 端点路径（默认 `/download`）
- `youtube.urlParamKey`: YouTube 链接参数名（默认 `url`）
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
