export type SocialPlatform = 'douyin' | 'xiaohongshu'

export type SendMode = 'base64' | 'url'

export type ToolContentLevel = 'summary' | 'full'

export interface ParsedContent {
  platform: SocialPlatform
  title: string
  content: string
  images: string[]
  videos: string[]
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
