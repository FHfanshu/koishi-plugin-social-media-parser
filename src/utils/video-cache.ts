import crypto from 'node:crypto'

import type { Logger } from 'koishi'

import type { DownloadedBuffer } from './http'

/**
 * Cache entry for downloaded video content.
 */
export interface VideoCacheEntry {
  buffer: Buffer
  mimeType: string
  url: string
  size: number
  createdAt: number
  expiresAt: number
  lastAccessedAt: number
}

/**
 * Configuration for video cache behavior.
 */
export interface VideoCacheConfig {
  enabled: boolean
  ttlMs: number
  maxSizeBytes: number
  maxEntries: number
}

/**
 * Default video cache configuration.
 */
export const DEFAULT_VIDEO_CACHE_CONFIG: VideoCacheConfig = {
  enabled: true,
  ttlMs: 30 * 60 * 1000, // 30 minutes
  maxSizeBytes: 200 * 1024 * 1024, // 200 MB
  maxEntries: 20,
}

/**
 * Generate a cache key from video and audio URLs.
 * Uses SHA-256 hash truncated to 32 characters for compact keys.
 */
export function generateCacheKey(videoUrl: string, audioUrl?: string): string {
  const raw = audioUrl ? `${videoUrl}|${audioUrl}` : videoUrl
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * Video cache manager with LRU eviction and concurrency control.
 */
export class VideoCacheManager {
  private cache: Map<string, VideoCacheEntry> = new Map()
  private pending: Map<string, Promise<DownloadedBuffer>> = new Map()
  private config: VideoCacheConfig
  private logger: Logger | null
  private currentSize: number = 0

  constructor(config: VideoCacheConfig, logger?: Logger) {
    this.config = { ...DEFAULT_VIDEO_CACHE_CONFIG, ...config }
    this.logger = logger || null
  }

  /**
   * Get a cached video if available and not expired.
   */
  get(key: string): VideoCacheEntry | null {
    if (!this.config.enabled) {
      return null
    }

    const entry = this.cache.get(key)
    if (!entry) {
      return null
    }

    const now = Date.now()
    if (now > entry.expiresAt) {
      this.deleteEntry(key)
      return null
    }

    // Update last accessed time for LRU tracking
    entry.lastAccessedAt = now
    return entry
  }

  /**
   * Store a video in the cache.
   */
  set(key: string, data: DownloadedBuffer): void {
    if (!this.config.enabled) {
      return
    }

    const size = data.buffer.length

    // Skip caching if the video is too large
    if (size > this.config.maxSizeBytes / 2) {
      this.logger?.warn(`video cache: skipping large video (${Math.round(size / 1024 / 1024)}MB > ${Math.round(this.config.maxSizeBytes / 2 / 1024 / 1024)}MB limit)`)
      return
    }

    // Evict entries if necessary
    this.evictIfNeeded(size)

    const now = Date.now()
    const entry: VideoCacheEntry = {
      buffer: data.buffer,
      mimeType: data.mimeType,
      url: data.url,
      size,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      lastAccessedAt: now,
    }

    // Remove old entry if exists
    const existing = this.cache.get(key)
    if (existing) {
      this.currentSize -= existing.size
    }

    this.cache.set(key, entry)
    this.currentSize += size

    this.logger?.debug(`video cache: stored ${key} (${Math.round(size / 1024 / 1024)}MB), total ${Math.round(this.currentSize / 1024 / 1024)}MB`)
  }

  /**
   * Get a cached video or download it using the provided downloader function.
   * Handles concurrent requests for the same URL by sharing the download promise.
   */
  async getOrDownload(
    key: string,
    downloader: () => Promise<DownloadedBuffer>
  ): Promise<DownloadedBuffer> {
    // Check cache first
    const cached = this.get(key)
    if (cached) {
      this.logger?.debug(`video cache hit: ${key}`)
      return {
        buffer: cached.buffer,
        mimeType: cached.mimeType,
        url: cached.url,
      }
    }

    // Check if download is already in progress
    const pending = this.pending.get(key)
    if (pending) {
      this.logger?.debug(`video cache: waiting for pending download: ${key}`)
      return pending
    }

    // Start a new download
    const downloadPromise = this.executeDownload(key, downloader)
    this.pending.set(key, downloadPromise)

    try {
      return await downloadPromise
    } finally {
      this.pending.delete(key)
    }
  }

  /**
   * Execute the download and cache the result on success.
   */
  private async executeDownload(
    key: string,
    downloader: () => Promise<DownloadedBuffer>
  ): Promise<DownloadedBuffer> {
    this.logger?.debug(`video cache: downloading: ${key}`)
    const result = await downloader()

    // Cache the result on success
    this.set(key, result)

    return result
  }

  /**
   * Evict entries to make room for a new entry.
   */
  private evictIfNeeded(newEntrySize: number): void {
    // Check entry count limit
    while (this.cache.size >= this.config.maxEntries) {
      this.evictLRU()
    }

    // Check size limit
    const targetSize = this.config.maxSizeBytes - newEntrySize
    while (this.currentSize > targetSize && this.cache.size > 0) {
      this.evictLRU()
    }
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.deleteEntry(oldestKey)
      this.logger?.debug(`video cache: evicted LRU entry ${oldestKey}`)
    }
  }

  /**
   * Delete an entry from the cache.
   */
  private deleteEntry(key: string): void {
    const entry = this.cache.get(key)
    if (entry) {
      this.currentSize -= entry.size
      this.cache.delete(key)
    }
  }

  /**
   * Clean up expired entries.
   */
  cleanup(): void {
    const now = Date.now()
    const expiredKeys: string[] = []

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        expiredKeys.push(key)
      }
    }

    for (const key of expiredKeys) {
      this.deleteEntry(key)
    }

    // Clean up stale pending downloads (older than 5 minutes)
    const pendingTimeout = 5 * 60 * 1000
    // Note: We don't have timestamps for pending downloads, so we can't clean them up here
    // They will be cleaned up when the download completes or fails

    if (expiredKeys.length > 0) {
      this.logger?.debug(`video cache: cleaned up ${expiredKeys.length} expired entries, total size ${Math.round(this.currentSize / 1024 / 1024)}MB`)
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): { entries: number; sizeBytes: number; maxSizeBytes: number; pendingDownloads: number } {
    return {
      entries: this.cache.size,
      sizeBytes: this.currentSize,
      maxSizeBytes: this.config.maxSizeBytes,
      pendingDownloads: this.pending.size,
    }
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear()
    this.currentSize = 0
    this.logger?.debug('video cache: cleared all entries')
  }
}

// Singleton instance per context
const VIDEO_CACHE_KEY = Symbol('social-media-parser:video-cache')

/**
 * Get or create the video cache manager for a given context.
 */
export function getVideoCacheManager(
  config: VideoCacheConfig,
  logger?: Logger
): VideoCacheManager {
  // Create a new instance - each plugin instance should have its own cache
  return new VideoCacheManager(config, logger)
}