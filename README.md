# koishi-plugin-social-media-parser

抖音 + 小红书二合一解析插件，支持自动解析、手动命令和 ChatLuna 工具调用。

## 功能

- 自动解析抖音/小红书链接（支持 guild 白名单）
- 手动命令：`parse <url>`
- ChatLuna 工具：`parse_social_media`
- 自动解析后可静默注入 ChatLuna 上下文
- 媒体注入链路支持图片压缩、短视频压缩、长视频抽帧+保留音频
- 长文本/多图自动合并转发，减少刷屏

## 配置要点

- `autoParse.guilds`: 自动解析群白名单
- `autoParse.injectContext`: 自动解析后注入上下文
- `autoParse.mediaInject.*`: 媒体注入参数（分辨率、时长、抽帧等）
- `forward.autoMergeForward`: 长文本/多图自动合并转发

## 开发

```bash
yarn workspace koishi-plugin-social-media-parser build
```

## 许可证

MIT
