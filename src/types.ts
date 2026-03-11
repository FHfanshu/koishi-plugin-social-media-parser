export type SocialPlatform = 'douyin' | 'xiaohongshu' | 'bilibili' | 'twitter' | 'youtube'

export type SendMode = 'base64' | 'url'

export type ToolContentLevel = 'summary' | 'full'

export type TwitterProvider = 'rapidapi' | 'grok'

export interface ParsedContent {
  platform: SocialPlatform
  title: string
  author?: string
  content: string
  translatedContent?: string
  images: string[]
  videos: string[]
  textProvider?: TwitterProvider
  imageProvider?: TwitterProvider
  videoProvider?: TwitterProvider
  translationProvider?: TwitterProvider
  videoDurationSec?: number
  musicUrl?: string
  originalUrl: string
  resolvedUrl?: string
}

export interface CompressedBinary {
  buffer: Buffer
  mimeType: string
  ext: string
}

export interface ProcessedVideoForContext {
  mode: 'short-video' | 'long-video'
  durationSec: number
  video?: CompressedBinary
  frames: CompressedBinary[]
  audio?: CompressedBinary
}
