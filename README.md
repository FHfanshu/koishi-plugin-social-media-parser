# koishi-plugin-social-media-parser

[![npm](https://img.shields.io/npm/v/koishi-plugin-social-media-parser?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-social-media-parser)

抖音 + 小红书 + 哔哩哔哩 + Twitter(X) 社交媒体链接解析插件，支持自动解析、手动命令和 ChatLuna 工具调用。

## 功能特性

- **多平台支持**: 抖音、小红书、哔哩哔哩、Twitter(X)
- **自动解析**: 群聊中自动识别并解析分享链接
- **手动命令**: `parse <url>` 手动触发解析
- **ChatLuna 工具**: 注册 `read_social_media` 工具供 AI 调用
- **智能合并转发**: 长文本/多图自动合并转发，减少刷屏
- **媒体处理**: 支持图片压缩、视频下载与压缩
- **平台级黑名单**: 按平台独立配置自动解析群黑名单

## 安装

```bash
npm install koishi-plugin-social-media-parser
```

## 依赖

- **必需**: `http` (Koishi HTTP 服务)
- **可选**: `chatluna` (ChatLuna 工具注册)
- **可选**: `chatluna_storage` (媒体持久化存储)
- **可选**: `ffmpeg` (视频处理)
- **可选**: `puppeteer` (小红书浏览器模式)

## 支持平台与链接格式

| 平台 | 支持的域名 |
|------|-----------|
| 抖音 | `v.douyin.com` / `www.douyin.com` / `www.iesdouyin.com` |
| 小红书 | `xiaohongshu.com` / `xhslink.com` |
| 哔哩哔哩 | `bilibili.com` / `b23.tv` / `bili22.cn` / `bili23.cn` / `bili33.cn` / `bili2233.cn` |
| Twitter/X | `x.com` / `twitter.com` / `t.co` / `fxtwitter.com` / `vxtwitter.com` |

## 最小配置

```yaml
social-media-parser:
  debug: false
  autoParse:
    enabled: true
    onlyGroup: true
  platforms:
    douyin:
      enabled: true
      api:
        baseUrl: https://api.douyin.wtf
    xiaohongshu:
      enabled: true
    bilibili:
      enabled: true
    twitter:
      enabled: false
  tool:
    enabled: true
    name: read_social_media
```

## 配置详解

### 通用设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | boolean | false | 调试模式（输出详细日志） |

### 网络设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `network.timeoutMs` | number | 15000 | 请求超时（ms） |
| `network.cooldownMs` | number | 8000 | 同一链接冷却时间（ms） |

### 媒体设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `media.maxBytes` | number | 15MB | 单媒体最大下载量 |
| `media.maxVideoBytes` | number | 512MB | 视频最大下载量 |
| `media.maxDurationSec` | number | 1800 | 视频最大时长（秒） |
| `media.sendMode` | string | base64 | 图片发送模式 (base64 / storage / url) |
| `media.videoSendMode` | string | base64 | 视频发送模式 (storage / base64 / url) |
| `media.fallbackToUrlOnError` | boolean | true | 发送失败时回退到直链 |

#### 视频缓存

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `media.videoCache.enabled` | boolean | true | 启用视频缓存（同视频多群复用） |
| `media.videoCache.ttlMs` | number | 30分钟 | 缓存有效期 |
| `media.videoCache.maxSizeBytes` | number | 200MB | 最大缓存大小 |
| `media.videoCache.maxEntries` | number | 20 | 最大缓存条目数 |

### 平台配置

#### 抖音

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `platforms.douyin.enabled` | boolean | true | 启用抖音解析 |
| `platforms.douyin.api.baseUrl` | string | https://api.douyin.wtf | 主 API 地址 |
| `platforms.douyin.api.fallbackUrls` | string[] | [] | 备用 API 列表 |
| `platforms.douyin.maxImages` | number | 9 | 图文最大图片数 |
| `platforms.douyin.autoParseBlockedGuilds` | string[] | [] | 自动解析群黑名单 |

#### 小红书

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `platforms.xiaohongshu.enabled` | boolean | true | 启用小红书解析 |
| `platforms.xiaohongshu.userAgent` | string | Chrome UA | User-Agent |
| `platforms.xiaohongshu.maxRetries` | number | 3 | 重试次数 |
| `platforms.xiaohongshu.maxImages` | number | 20 | 图文最大图片数 |
| `platforms.xiaohongshu.useBrowser` | boolean | false | 浏览器模式（需 puppeteer） |
| `platforms.xiaohongshu.cookies` | string | - | 登录 Cookie |
| `platforms.xiaohongshu.autoParseBlockedGuilds` | string[] | [] | 自动解析群黑名单 |

#### 哔哩哔哩

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `platforms.bilibili.enabled` | boolean | true | 启用 B 站解析 |
| `platforms.bilibili.fetchVideo` | boolean | true | 获取视频直链 |
| `platforms.bilibili.videoQuality` | number | 720 | 视频画质 (480 / 720) |
| `platforms.bilibili.maxDescLength` | number | 100 | 简介最大长度 |
| `platforms.bilibili.autoParseBlockedGuilds` | string[] | [] | 自动解析群黑名单 |

#### Twitter/X

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `platforms.twitter.enabled` | boolean | false | 启用 Twitter 解析 |
| `platforms.twitter.maxImages` | number | 9 | 最大图片数 |
| `platforms.twitter.grok.enabled` | boolean | false | 启用 Grok 解析 |
| `platforms.twitter.grok.model` | string | grok-4.1-fast | Grok 模型 |
| `platforms.twitter.grok.timeoutMs` | number | 35000 | Grok 超时（ms） |
| `platforms.twitter.routing.textProviderOrder` | string | fxtwitter,grok | 文本解析优先级 |
| `platforms.twitter.translation.enabled` | boolean | false | 启用翻译 |
| `platforms.twitter.translation.targetLanguage` | string | zh-CN | 目标语言 |
| `platforms.twitter.autoParseBlockedGuilds` | string[] | [] | 自动解析群黑名单 |

### 自动解析

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `autoParse.enabled` | boolean | true | 启用自动解析 |
| `autoParse.onlyGroup` | boolean | true | 仅群聊触发 |
| `autoParse.blacklist.users` | string[] | [] | 用户黑名单 |
| `autoParse.maxUrlsPerMessage` | number | 3 | 单条消息最大解析数 |

### 合并转发

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `forward.enabled` | boolean | true | 启用合并转发 |
| `forward.nickname` | string | 内容解析 | 转发昵称 |
| `forward.autoMergeForward` | boolean | true | 长文/多图自动合并 |
| `forward.longTextThreshold` | number | 260 | 触发合并的文本长度 |
| `forward.imageMergeThreshold` | number | 2 | 触发合并的图片数 |
| `forward.maxForwardNodes` | number | 25 | 最大转发节点数 |

### ChatLuna 工具

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tool.enabled` | boolean | true | 注册 ChatLuna 工具 |
| `tool.name` | string | read_social_media | 工具名称 |
| `tool.description` | string | 读取社媒链接... | 工具描述 |

## 使用方式

### 自动解析

群聊中发送包含支持平台链接的消息，插件会自动识别并解析。

### 手动命令

```
parse <url>
```

### ChatLuna 工具

启用 `tool.enabled` 后，ChatLuna 可调用 `read_social_media` 工具解析链接。

## 注意事项

- OneBot 协议端发送合并转发消息时可能超时，若频繁失败可关闭 `forward.autoMergeForward`
- 小红书浏览器模式需安装 `puppeteer`，适用于需要登录才能查看的内容
- Twitter 解析默认关闭，需手动启用 `platforms.twitter.enabled`
- 视频发送建议使用 `storage` 或 `base64` 模式，`url` 模式兼容性最差

## License

MIT