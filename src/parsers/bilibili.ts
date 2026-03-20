import crypto from 'node:crypto'

import type { Context, Logger } from 'koishi'

import type { Config } from '../config'
import type { CommentItem, ParsedContent } from '../types'
import { NetworkError, NotFoundError, ParseError, RateLimitError } from '../utils/errors'
import { requestText, resolveRedirect } from '../utils/http'
import { withRetry } from '../utils/retry'
import { isSafePublicHttpUrl } from '../utils/url'

const BVID_RE = /BV[0-9a-zA-Z]{10}/i
const AVID_RE = /(?:^|[^a-zA-Z0-9])av(\d+)/i
const BILIBILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Bilibili 非视频链接路径（专栏/直播/动态/相簿等）
const BILIBILI_NON_VIDEO_PATHS = [
  '/read/',      // 专栏
  '/opus/',      // 动态 (新版)
  '/dynamic/',   // 动态 (旧版)
  '/v/topic/',   // 话题
  '/space/',     // 用户空间
  '/member/',    // 会员中心
  '/account/',   // 账号相关
  '/bangumi/',   // 番剧
  '/cheese/',    // 课程
  '/blackboard/', // 活动
  '/audio/',     // 音频
  '/medialist/', // 收藏夹
  '/list/',      // 播放列表
]

function isBilibiliNonVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()

    // 直播链接
    if (host === 'live.bilibili.com' || host.endsWith('.live.bilibili.com')) {
      return true
    }

    // t.bilibili.com 是动态短链
    if (host === 't.bilibili.com') {
      return true
    }

    // 检查非视频路径
    for (const nonVideoPath of BILIBILI_NON_VIDEO_PATHS) {
      if (path.startsWith(nonVideoPath)) {
        return true
      }
    }

    return false
  } catch {
    return false
  }
}

// WBI mixin key index (from B站)
const WBI_MIXIN_INDEX = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

interface BilibiliVideoId {
  type: 'bv' | 'av'
  value: string
}

interface BilibiliVideoDetail {
  title: string
  description: string
  owner: string
  cover: string
  bvid: string
  aid: string
  cid: string
  durationSec: number
  page: number
  stats: {
    view: number
    like: number
    coin: number
    favorite: number
    share: number
    danmaku: number
    comment: number
  }
}

interface BilibiliPlayInfo {
  videoUrl: string
  audioUrl: string
  videoUrls: string[]
  audioUrls: string[]
  videoCodecid: number
  videoQuality: number
}

interface BilibiliComment {
  user: string
  content: string
  likes: number
  isPinned: boolean
}

interface WbiMixinCache {
  value: string
  expiresAt: number
  pending: Promise<string> | null
}

/**
 * Create a new WBI cache instance for multi-instance isolation.
 * Each plugin instance should have its own cache to avoid state conflicts.
 */
export function createWbiCache(): WbiMixinCache {
  return {
    value: '',
    expiresAt: 0,
    pending: null,
  }
}

// Default module-level cache for backward compatibility (single-instance scenarios)
const DEFAULT_WBI_CACHE: WbiMixinCache = createWbiCache()

// Symbol key for storing cache in Context
const WBI_CACHE_KEY = Symbol('social-media-parser:bilibili-wbi-cache')

/**
 * Get or create WBI cache for a given context.
 * This ensures each plugin instance has its own cache.
 */
function getWbiCache(ctx: Context): WbiMixinCache {
  const ctxWithCache = ctx as Context & { [WBI_CACHE_KEY]?: WbiMixinCache }
  if (!ctxWithCache[WBI_CACHE_KEY]) {
    ctxWithCache[WBI_CACHE_KEY] = createWbiCache()
  }
  return ctxWithCache[WBI_CACHE_KEY]
}

export async function parseBilibili(
  ctx: Context,
  inputUrl: string,
  config: Config,
  logger: Logger
): Promise<ParsedContent> {
  // 跳过非视频链接（专栏/直播/动态等），静默处理
  if (isBilibiliNonVideoUrl(inputUrl)) {
    throw new Error('该类型链接解析已禁用。')
  }

  const finalUrl = await resolveRedirect(ctx, inputUrl, config.network.timeoutMs, logger)

  // 跳过重定向后的非视频链接
  if (isBilibiliNonVideoUrl(finalUrl)) {
    throw new Error('该类型链接解析已禁用。')
  }

  const directId = extractVideoId(inputUrl)
  const videoId = directId || extractVideoId(finalUrl)
  const page = extractPageNo(finalUrl) || extractPageNo(inputUrl) || 1

  if (!videoId) {
    throw new Error('无法从 Bilibili 链接中提取 BV/AV 号')
  }

  const detail = await fetchVideoDetail(ctx, videoId, page, config, logger)

  if (!detail.bvid || !detail.cid) {
    throw new Error('B站视频信息不完整，缺少 bvid 或 cid')
  }

  const canonicalUrl = page > 1
    ? `https://www.bilibili.com/video/${detail.bvid}?p=${page}`
    : `https://www.bilibili.com/video/${detail.bvid}`

  let playInfo: BilibiliPlayInfo | null = null
  let videoUrls: string[] = []
  let audioUrls: string[] = []

  if (config.platforms.bilibili.fetchVideo) {
    // 优先使用官方 API (WBI 签名)
    playInfo = await fetchPlayInfoViaOfficialApi(ctx, detail, config, logger)

    if (playInfo?.videoUrl) {
      videoUrls = playInfo.videoUrls.length > 0 ? playInfo.videoUrls : [playInfo.videoUrl]
      audioUrls = playInfo.audioUrls.length > 0
        ? playInfo.audioUrls
        : (playInfo.audioUrl ? [playInfo.audioUrl] : [])
      logger.debug(`bilibili official api success: ${canonicalUrl}`)
    } else {
      // Fallback 到第三方 API
      const thirdPartyVideoUrl = await fetchVideoViaThirdParty(ctx, detail, canonicalUrl, config, logger)
      if (thirdPartyVideoUrl) {
        videoUrls = [thirdPartyVideoUrl]
      }
      if (videoUrls.length === 0) {
        logger.warn(`bilibili video direct link unavailable: ${canonicalUrl}`)
      }
    }
  }

  // Fetch comments and tags in parallel (non-blocking, best-effort)
  const [comments, tags] = await Promise.all([
    config.platforms.bilibili.fetchComments
      ? fetchBilibiliComments(ctx, detail.aid, config.platforms.bilibili.commentCount, config, logger)
      : Promise.resolve([]),
    config.platforms.bilibili.fetchTags
      ? fetchBilibiliTags(ctx, detail.bvid, config.platforms.bilibili.maxTagCount, config, logger)
      : Promise.resolve([]),
  ])

  const extra: Record<string, unknown> = {
    bvid: detail.bvid,
    aid: detail.aid,
    cid: detail.cid,
    page,
    engagement: detail.stats,
    videoQuality: playInfo?.videoQuality,
    videoCodecid: playInfo?.videoCodecid,
  }

  return {
    platform: 'bilibili',
    title: detail.title,
    author: detail.owner || undefined,
    content: buildContent(detail, config.platforms.bilibili.maxDescLength),
    descriptionFull: compactDescription(detail.description) || undefined,
    images: detail.cover ? [detail.cover] : [],
    videos: videoUrls,
    audios: audioUrls,
    videoDurationSec: detail.durationSec > 0 ? detail.durationSec : undefined,
    tags: tags.length > 0 ? tags : undefined,
    comments: comments.length > 0 ? comments : undefined,
    originalUrl: inputUrl,
    resolvedUrl: canonicalUrl,
    extra,
  }
}

async function fetchVideoDetail(
  ctx: Context,
  videoId: BilibiliVideoId,
  page: number,
  config: Config,
  logger: Logger
): Promise<BilibiliVideoDetail> {
  const query = videoId.type === 'bv'
    ? `bvid=${encodeURIComponent(videoId.value)}`
    : `aid=${encodeURIComponent(videoId.value)}`
  const endpoint = `https://api.bilibili.com/x/web-interface/view?${query}`

  const payload = await withRetry(
    () => requestJson(ctx, endpoint, config.network.timeoutMs, logger),
    {
      maxRetries: 2,
      baseDelayMs: 1000,
      shouldRetry: (err) => {
        const msg = err.message.toLowerCase()
        return msg.includes('network') || msg.includes('timeout') || msg.includes('empty')
      },
      onRetry: (attempt, err) => {
        logger.info(`bilibili video detail retry ${attempt}: ${err.message}`)
      },
    }
  )

  const code = toNumber(payload?.code)
  if (code === -404 || code === 404) {
    throw new NotFoundError('bilibili', '视频不存在或已被删除')
  }
  if (code === -400 || code === 400) {
    throw new NotFoundError('bilibili', '视频 ID 无效')
  }
  if (code === -503 || code === 503) {
    throw new RateLimitError('bilibili', 'B站服务暂时不可用')
  }
  if (code !== 0 || !payload?.data) {
    const reason = typeof payload?.message === 'string' ? payload.message : `code=${code}`
    throw new ParseError('api_error', 'bilibili', `Bilibili 元数据获取失败：${reason}`)
  }

  const data = payload.data
  const pages = Array.isArray(data.pages) ? data.pages : []
  const picked = pages[page - 1] || pages[0]

  const bvid = normalizeBvid(data?.bvid) || (videoId.type === 'bv' ? normalizeBvid(videoId.value) : '')
  const aid = normalizeAid(data?.aid) || (videoId.type === 'av' ? normalizeAid(videoId.value) : '')
  const cid = normalizeCid(data?.cid || picked?.cid)

  return {
    title: asString(data?.title).trim() || `bilibili:${bvid || videoId.value}`,
    description: asString(data?.desc).trim(),
    owner: asString(data?.owner?.name).trim(),
    cover: normalizeResourceUrl(asString(data?.pic)),
    bvid,
    aid,
    cid,
    durationSec: toNumber(picked?.duration || data?.duration),
    page,
    stats: {
      view: toNumber(data?.stat?.view),
      like: toNumber(data?.stat?.like),
      coin: toNumber(data?.stat?.coin),
      favorite: toNumber(data?.stat?.favorite),
      share: toNumber(data?.stat?.share),
      danmaku: toNumber(data?.stat?.danmaku),
      comment: toNumber(data?.stat?.reply),
    },
  }
}

async function fetchPlayInfoViaOfficialApi(
  ctx: Context,
  detail: BilibiliVideoDetail,
  config: Config,
  logger: Logger
): Promise<BilibiliPlayInfo | null> {
  if (!detail.bvid || !detail.cid) {
    return null
  }

  const qn = config.platforms.bilibili.videoQuality === 720 ? 64 : 32

  // 尝试 WBI 签名接口
  try {
    const wbiResult = await fetchPlayInfoWithWbi(ctx, detail.bvid, detail.cid, qn, config, logger)
    if (wbiResult) {
      return wbiResult
    }
  } catch (err) {
    logger.debug(`bilibili WBI playurl failed: ${(err as Error)?.message}, fallback to old api`)
  }

  // Fallback 到旧接口
  const endpoint = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(detail.bvid)}&cid=${encodeURIComponent(detail.cid)}&qn=${qn}&fnval=16&fnver=0&fourk=0`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs, logger)
    const code = toNumber(payload?.code)
    if (code !== 0 || !payload?.data) {
      logger.debug(`bilibili old playurl failed: code=${code}`)
      return null
    }

    return extractPlayInfoFromData(payload.data, qn)
  } catch (err) {
    logger.debug(`bilibili old playurl request failed: ${(err as Error)?.message}`)
    return null
  }
}

async function fetchPlayInfoWithWbi(
  ctx: Context,
  bvid: string,
  cid: string,
  qn: number,
  config: Config,
  logger: Logger
): Promise<BilibiliPlayInfo | null> {
  const mixinKey = await getWbiMixinKey(ctx, config, logger)
  const wts = Math.floor(Date.now() / 1000).toString()

  const query: Record<string, string> = {
    bvid,
    cid,
    qn: String(qn),
    fnval: '16',
    fnver: '0',
    fourk: '0',
  }

  const sorted = Object.keys(query).sort().map((key) => {
    const value = String(query[key]).replace(/[!'()*]/g, '')
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  })
  sorted.push(`wts=${wts}`)
  const plain = sorted.join('&')
  const wRid = crypto.createHash('md5').update(`${plain}${mixinKey}`).digest('hex')
  const finalUrl = `https://api.bilibili.com/x/player/wbi/playurl?${plain}&w_rid=${wRid}`

  const payload = await requestJson(ctx, finalUrl, config.network.timeoutMs, logger)
  const code = toNumber(payload?.code)
  if (code !== 0 || !payload?.data) {
    return null
  }

  return extractPlayInfoFromData(payload.data, qn)
}

function extractPlayInfoFromData(data: any, qn: number): BilibiliPlayInfo | null {
  const dash = data.dash
  const videos = dash?.video || []
  const audios = dash?.audio || []

  // 选择视频流
  let videoUrl = ''
  let videoUrls: string[] = []
  let videoCodecid = 0
  let videoQuality = qn === 64 ? 720 : 480

  if (videos.length > 0) {
    const sorted = videos.map((item: any) => {
      const urls = collectMediaUrls(item, ['baseUrl', 'base_url'], ['backupUrl', 'backup_url'])
      return {
        id: toNumber(item.id),
        height: toNumber(item.height),
        codecid: toNumber(item.codecid),
        bandwidth: toNumber(item.bandwidth),
        urls,
        url: urls[0] || '',
      }
    }).filter((item: any) => item.url).sort((a: any, b: any) => b.height - a.height)

    // 按编码优先级选择: AV1 > HEVC > AVC
    const pickByCodec = (list: any[]) => {
      const av1 = list.filter(item => item.codecid === 13).sort((a, b) => b.bandwidth - a.bandwidth)[0]
      if (av1) return av1
      const hevc = list.filter(item => item.codecid === 12).sort((a, b) => b.bandwidth - a.bandwidth)[0]
      if (hevc) return hevc
      const avc = list.filter(item => item.codecid === 7).sort((a, b) => b.bandwidth - a.bandwidth)[0]
      if (avc) return avc
      return list.sort((a, b) => b.bandwidth - a.bandwidth)[0]
    }

    const byId = sorted.filter((item: any) => item.id === qn)
    const picked = byId.length > 0
      ? pickByCodec(byId)
      : qn === 64
        ? pickByCodec(sorted.filter((item: any) => item.height <= 720)) || pickByCodec(sorted)
        : pickByCodec(sorted.filter((item: any) => item.height <= 480)) || pickByCodec(sorted)

    if (picked) {
      videoUrls = filterTrustedBilibiliUrls(picked.urls)
      videoUrl = videoUrls[0] || ''
      videoCodecid = picked.codecid
      videoQuality = picked.height >= 720 ? 720 : 480
    }
  }

  // 选择音频流
  let audioUrl = ''
  let audioUrls: string[] = []
  if (audios.length > 0) {
    const audioSorted = audios.map((item: any) => {
      const urls = collectMediaUrls(item, ['baseUrl', 'base_url'], ['backupUrl', 'backup_url'])
      return {
        id: toNumber(item.id),
        bandwidth: toNumber(item.bandwidth),
        urls,
        url: urls[0] || '',
      }
    }).filter((item: any) => item.url).sort((a: any, b: any) => b.bandwidth - a.bandwidth)

    if (audioSorted.length > 0) {
      audioUrls = filterTrustedBilibiliUrls(audioSorted[0].urls)
      audioUrl = audioUrls[0] || ''
    }
  }

  // 非DASH格式 (durl)
  if (!videoUrl && Array.isArray(data.durl)) {
    for (const item of data.durl) {
      const candidates = filterTrustedBilibiliUrls(collectMediaUrls(item, ['url'], ['backup_url', 'backupUrl']))
      if (candidates.length > 0) {
        videoUrls = candidates
        videoUrl = candidates[0]
        break
      }
    }
  }

  if (!videoUrl || videoUrls.length === 0) {
    return null
  }

  // 安全检查
  if (audioUrls.length === 0) {
    audioUrl = ''
  }

  return { videoUrl, audioUrl, videoUrls, audioUrls, videoCodecid, videoQuality }
}

async function getWbiMixinKey(ctx: Context, config: Config, logger: Logger): Promise<string> {
  const cache = getWbiCache(ctx)
  const now = Date.now()
  if (cache.value && now < cache.expiresAt) {
    return cache.value
  }

  if (!cache.pending) {
    cache.pending = (async () => {
      let lastError = ''

      // 方案1: 通过 nav 接口
      for (let i = 0; i < 3; i++) {
        try {
          const payload = await requestJson(ctx, 'https://api.bilibili.com/x/web-interface/nav', config.network.timeoutMs, logger)
          const wbi = payload?.data?.wbi_img
          if (!wbi || typeof wbi !== 'object') {
            throw new Error(`code=${payload?.code} message=${payload?.message}`)
          }
          const img = asString(wbi.img_url)
          const sub = asString(wbi.sub_url)
          const imgKey = img.split('/').pop()?.split('.')[0] || ''
          const subKey = sub.split('/').pop()?.split('.')[0] || ''
          const raw = `${imgKey}${subKey}`
          const mixin = WBI_MIXIN_INDEX.map(idx => raw[idx]).join('').slice(0, 32)
          if (!mixin || mixin.length < 32) {
            throw new Error('empty-mixin')
          }
          cache.value = mixin
          cache.expiresAt = Date.now() + 10 * 60 * 1000 // 10分钟缓存
          return mixin
        } catch (err) {
          lastError = (err as Error)?.message || String(err)
          if (i < 2) {
            await sleep(200 * (i + 1))
          }
        }
      }

      // 方案2: 从首页 HTML 提取
      try {
        const html = await requestText(ctx, 'https://www.bilibili.com/', config.network.timeoutMs, {
          'user-agent': BILIBILI_UA,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })
        // 尝试从 __INITIAL_STATE__ 中提取
        const match = html.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
        if (match) {
          const state = JSON.parse(match[1])
          const wbi = state?.wbi?.img
          if (wbi) {
            const img = asString(wbi.img_url)
            const sub = asString(wbi.sub_url)
            const imgKey = img.split('/').pop()?.split('.')[0] || ''
            const subKey = sub.split('/').pop()?.split('.')[0] || ''
            const raw = `${imgKey}${subKey}`
            const mixin = WBI_MIXIN_INDEX.map(idx => raw[idx]).join('').slice(0, 32)
            if (mixin && mixin.length >= 32) {
              cache.value = mixin
              cache.expiresAt = Date.now() + 10 * 60 * 1000
              logger.debug('WBI key extracted from homepage HTML')
              return mixin
            }
          }
        }
      } catch (err) {
        logger.debug(`WBI fallback from HTML failed: ${(err as Error)?.message}`)
      }

      if (cache.value) {
        logger.warn(`WBI refresh failed, using cached value: ${lastError}`)
        return cache.value
      }
      throw new Error(`获取 WBI 签名参数失败：${lastError}`)
    })().finally(() => {
      cache.pending = null
    })
  }

  return cache.pending
}

async function fetchVideoViaThirdParty(
  ctx: Context,
  detail: BilibiliVideoDetail,
  bilibiliUrl: string,
  config: Config,
  logger: Logger
): Promise<string> {
  // Try xingzhige first (most reliable)
  const xingzhigeUrl = await fetchVideoViaXingzhige(ctx, bilibiliUrl, config, logger)
  if (xingzhigeUrl) {
    return xingzhigeUrl
  }

  // Try injahow
  const injahowUrl = await fetchVideoViaInjahow(ctx, detail, config, logger)
  if (injahowUrl) {
    return injahowUrl
  }

  // Try bilibili.ii1.fun (new fallback)
  const ii1funUrl = await fetchVideoViaIi1Fun(ctx, bilibiliUrl, config, logger)
  if (ii1funUrl) {
    return ii1funUrl
  }

  return ''
}

async function fetchVideoViaXingzhige(
  ctx: Context,
  bilibiliUrl: string,
  config: Config,
  logger: Logger
): Promise<string> {
  const endpoint = `https://api.xingzhige.com/API/b_parse/?url=${encodeURIComponent(bilibiliUrl)}`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs, logger)
    const code = toNumber(payload?.code)
    const videoUrl = normalizeResourceUrl(asString(payload?.data?.video?.url).trim())

    if (code === 0 && videoUrl) {
      if (!isSafePublicHttpUrl(videoUrl) || !isTrustedBilibiliVideoUrl(videoUrl)) {
        logger.warn(`xingzhige url blocked by safety policy: ${videoUrl}`)
        return ''
      }
      return videoUrl
    }

    logger.debug(`xingzhige unavailable: code=${code}`)
    return ''
  } catch (err) {
    logger.debug(`xingzhige request failed: ${(err as Error)?.message}`)
    return ''
  }
}

async function fetchVideoViaInjahow(
  ctx: Context,
  detail: BilibiliVideoDetail,
  config: Config,
  logger: Logger
): Promise<string> {
  if (!detail.bvid && !detail.aid) {
    return ''
  }

  const query = detail.bvid
    ? `bv=${encodeURIComponent(detail.bvid)}`
    : `av=${encodeURIComponent(detail.aid)}`

  const endpoint = `https://api.injahow.cn/bparse/?${query}&p=${detail.page}&q=64&format=mp4&otype=json`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs, logger)
    const code = toNumber(payload?.code)
    const videoUrl = normalizeResourceUrl(asString(payload?.url).trim())

    if (code === 0 && videoUrl) {
      if (!isSafePublicHttpUrl(videoUrl) || !isTrustedBilibiliVideoUrl(videoUrl)) {
        logger.warn(`injahow url blocked by safety policy: ${videoUrl}`)
        return ''
      }
      return videoUrl
    }

    logger.debug(`injahow unavailable: code=${code}`)
    return ''
  } catch (err) {
    logger.debug(`injahow request failed: ${(err as Error)?.message}`)
    return ''
  }
}

async function fetchVideoViaIi1Fun(
  ctx: Context,
  bilibiliUrl: string,
  config: Config,
  logger: Logger
): Promise<string> {
  const endpoint = `https://bilibili.ii1.fun/api/video?url=${encodeURIComponent(bilibiliUrl)}`

  try {
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs, logger)
    // ii1.fun returns data.url for video
    const videoUrl = normalizeResourceUrl(asString(payload?.data?.url || payload?.url).trim())

    if (videoUrl) {
      if (!isSafePublicHttpUrl(videoUrl) || !isTrustedBilibiliVideoUrl(videoUrl)) {
        logger.warn(`ii1.fun url blocked by safety policy: ${videoUrl}`)
        return ''
      }
      return videoUrl
    }

    logger.debug(`ii1.fun unavailable: no video url in response`)
    return ''
  } catch (err) {
    logger.debug(`ii1.fun request failed: ${(err as Error)?.message}`)
    return ''
  }
}

async function fetchBilibiliComments(
  ctx: Context,
  aid: string,
  maxCount: number,
  config: Config,
  logger: Logger
): Promise<BilibiliComment[]> {
  if (!aid || maxCount <= 0) return []

  const comments: BilibiliComment[] = []
  const seen = new Set<string>()

  const addComment = (user: string, content: string, likes: number, isPinned: boolean) => {
    const normalizedUser = user.trim() || '匿名用户'
    // 压缩评论中的换行与多余空白，避免空评论和换行差异导致的重复
    const compact = content.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!compact) return
    const key = `${normalizedUser}:${compact}`
    if (seen.has(key)) return
    seen.add(key)
    comments.push({ user: normalizedUser, content: truncate(compact, 120), likes, isPinned })
  }

  // Fetch pinned comment (置顶评论)
  try {
    const pinnedEndpoint = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${encodeURIComponent(aid)}&mode=2&ps=1`
    const pinnedPayload = await requestJson(ctx, pinnedEndpoint, config.network.timeoutMs, logger)
    if (toNumber(pinnedPayload?.code) === 0 && pinnedPayload?.data?.upper) {
      const upper = pinnedPayload.data.upper
      const topReply = upper.top_reply
      if (topReply) {
        addComment(
          asString(topReply.member?.uname),
          asString(topReply.content?.message),
          toNumber(topReply.like),
          true
        )
      }
    }
  } catch (err) {
    const message = `bilibili pinned comment fetch failed: ${(err as Error)?.message}`
    if (config.debug) {
      logger.info(message)
    } else {
      logger.debug(message)
    }
  }

  // Fetch hot comments (热评)
  try {
    const hotEndpoint = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${encodeURIComponent(aid)}&mode=3&ps=${Math.min(maxCount, 10)}`
    const hotPayload = await requestJson(ctx, hotEndpoint, config.network.timeoutMs, logger)
    if (toNumber(hotPayload?.code) === 0 && Array.isArray(hotPayload?.data?.replies)) {
      for (const reply of hotPayload.data.replies) {
        if (comments.length >= maxCount) break
        addComment(
          asString(reply.member?.uname),
          asString(reply.content?.message),
          toNumber(reply.like),
          false
        )
      }
    }
  } catch (err) {
    const message = `bilibili hot comments fetch failed: ${(err as Error)?.message}`
    if (config.debug) {
      logger.info(message)
    } else {
      logger.debug(message)
    }
  }

  return comments
}

async function fetchBilibiliTags(
  ctx: Context,
  bvid: string,
  maxCount: number,
  config: Config,
  logger: Logger
): Promise<string[]> {
  if (!bvid || maxCount <= 0) return []

  try {
    const endpoint = `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`
    const payload = await requestJson(ctx, endpoint, config.network.timeoutMs, logger)

    if (toNumber(payload?.code) !== 0 || !Array.isArray(payload?.data)) {
      const message = `bilibili tags api: code=${payload?.code}`
      if (config.debug) {
        logger.info(message)
      } else {
        logger.debug(message)
      }
      return []
    }

    return payload.data
      .map((tag: any) => asString(tag?.tag_name).trim())
      .filter((name: string) => name.length > 0)
      .slice(0, maxCount)
  } catch (err) {
    const message = `bilibili tags fetch failed: ${(err as Error)?.message}`
    if (config.debug) {
      logger.info(message)
    } else {
      logger.debug(message)
    }
    return []
  }
}

function extractVideoId(input: string): BilibiliVideoId | null {
  if (!input) {
    return null
  }

  try {
    const parsed = new URL(input)
    const queryBvid = parsed.searchParams.get('bvid')
    if (queryBvid && BVID_RE.test(queryBvid)) {
      return {
        type: 'bv',
        value: normalizeBvid(queryBvid),
      }
    }

    const queryAid = parsed.searchParams.get('aid')
    if (queryAid && /^\d+$/.test(queryAid)) {
      return {
        type: 'av',
        value: queryAid,
      }
    }

    const path = decodeURIComponent(parsed.pathname || '')
    const pathBvid = path.match(/\/video\/(BV[0-9a-zA-Z]{10})/i)?.[1]
    if (pathBvid) {
      return {
        type: 'bv',
        value: normalizeBvid(pathBvid),
      }
    }

    const pathAvid = path.match(/\/video\/av(\d+)/i)?.[1]
    if (pathAvid) {
      return {
        type: 'av',
        value: pathAvid,
      }
    }
  } catch {
    // ignore URL parse errors and fallback to global pattern matching
  }

  const bvid = input.match(BVID_RE)?.[0]
  if (bvid) {
    return {
      type: 'bv',
      value: normalizeBvid(bvid),
    }
  }

  const avid = input.match(AVID_RE)?.[1]
  if (avid) {
    return {
      type: 'av',
      value: avid,
    }
  }

  return null
}

function extractPageNo(input: string): number {
  try {
    const url = new URL(input)
    const p = Number(url.searchParams.get('p') || 0)
    if (Number.isInteger(p) && p > 0) {
      return p
    }
  } catch {
    // ignore
  }
  return 0
}

async function requestJson(
  ctx: Context,
  url: string,
  timeoutMs: number,
  logger: Logger
): Promise<any> {
  const text = await requestText(ctx, url, timeoutMs, {
    referer: 'https://www.bilibili.com/',
    accept: 'application/json,text/plain,*/*',
    'user-agent': BILIBILI_UA,
  })

  if (!text || typeof text !== 'string') {
    throw new Error('empty response')
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid json response')
  }
}

function buildContent(detail: BilibiliVideoDetail, maxDescLength: number): string {
  const lines = [
    `播放: ${formatCount(detail.stats.view)} | 点赞: ${formatCount(detail.stats.like)} | 投币: ${formatCount(detail.stats.coin)}`,
    `收藏: ${formatCount(detail.stats.favorite)} | 转发: ${formatCount(detail.stats.share)} | 评论: ${formatCount(detail.stats.comment)}`,
  ]

  if (detail.page > 1) {
    lines.push(`分P: 第 ${detail.page} P`)
  }

  const compactDesc = compactDescription(detail.description)

  const description = truncate(compactDesc, maxDescLength)
  if (description) {
    lines.push(`简介: ${description}`)
  }

  return lines.join('\n')
}

function compactDescription(input: string): string {
  return `${input || ''}`
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(input: string, maxLength: number): string {
  if (!input) {
    return ''
  }
  if (!maxLength || maxLength < 1 || input.length <= maxLength) {
    return input
  }
  return `${input.slice(0, maxLength)}...`
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }
  if (value >= 100_000_000) {
    return `${formatCompact(value / 100_000_000)}亿`
  }
  if (value >= 10_000) {
    return `${formatCompact(value / 10_000)}万`
  }
  return String(Math.floor(value))
}

function formatCompact(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

function normalizeResourceUrl(url: string): string {
  const value = asString(url).trim()
  if (!value) {
    return ''
  }
  if (value.startsWith('//')) {
    return `https:${value}`
  }
  return value
}

function collectMediaUrls(
  item: any,
  primaryKeys: string[],
  backupKeys: string[]
): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  const pushIfValid = (input: unknown) => {
    const normalized = normalizeResourceUrl(asString(input))
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    result.push(normalized)
  }

  for (const key of primaryKeys) {
    pushIfValid(item?.[key])
  }

  for (const key of backupKeys) {
    const values = item?.[key]
    if (Array.isArray(values)) {
      for (const value of values) {
        pushIfValid(value)
      }
    }
  }

  return result
}

function filterTrustedBilibiliUrls(urls: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    if (!url || seen.has(url)) {
      continue
    }
    if (!isSafePublicHttpUrl(url) || !isTrustedBilibiliVideoUrl(url)) {
      continue
    }
    seen.add(url)
    result.push(url)
  }
  return result
}

function normalizeBvid(value: string): string {
  const text = asString(value).trim()
  if (!text) {
    return ''
  }

  const exact = text.match(/^(?:bv|BV)([0-9a-zA-Z]{10})$/)
  if (exact) {
    return `BV${exact[1]}`
  }

  const partial = text.match(/(?:bv|BV)([0-9a-zA-Z]{10})/)
  if (partial) {
    return `BV${partial[1]}`
  }

  return text
}

function normalizeAid(value: unknown): string {
  const text = asString(value).trim()
  if (/^\d+$/.test(text)) {
    return text
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }

  return ''
}

function normalizeCid(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }

  const text = asString(value).trim()
  if (/^\d+$/.test(text)) {
    return text
  }

  return ''
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function isTrustedBilibiliVideoUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.includes('bilivideo.')
      || hostname === 'bilibili.com'
      || hostname.endsWith('.bilibili.com')
      || hostname === 'hdslb.com'
      || hostname.endsWith('.hdslb.com')
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
