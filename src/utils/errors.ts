/**
 * Structured error types for social media parsing.
 * Each error type includes a platform identifier and error code for better error handling.
 */

/**
 * Base class for all parsing errors.
 */
export class ParseError extends Error {
  public readonly code: string
  public readonly platform: string

  constructor(code: string, platform: string, message: string) {
    super(message)
    this.name = 'ParseError'
    this.code = code
    this.platform = platform

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Check if this error should trigger a retry.
   */
  isRetryable(): boolean {
    // By default, only network errors are retryable
    return this.code === 'network' || this.code === 'rate_limit'
  }

  /**
   * Get a user-friendly error message.
   */
  toUserMessage(): string {
    return this.message
  }
}

/**
 * Rate limit exceeded error (HTTP 429).
 * Should trigger retry with exponential backoff.
 */
export class RateLimitError extends ParseError {
  public readonly retryAfter?: number

  constructor(platform: string, message: string = '请求频率超限，请稍后重试', retryAfter?: number) {
    super('rate_limit', platform, message)
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }

  override isRetryable(): boolean {
    return true
  }
}

/**
 * Authentication required error.
 * The endpoint requires login or API key.
 */
export class AuthError extends ParseError {
  constructor(platform: string, message: string = '需要登录或 API 密钥') {
    super('auth_required', platform, message)
    this.name = 'AuthError'
  }

  override isRetryable(): boolean {
    return false
  }
}

/**
 * Resource not found error.
 * The requested content does not exist or has been deleted.
 */
export class NotFoundError extends ParseError {
  constructor(platform: string, message: string = '内容不存在或已被删除') {
    super('not_found', platform, message)
    this.name = 'NotFoundError'
  }

  override isRetryable(): boolean {
    return false
  }
}

/**
 * Network connectivity error.
 * Connection failed, timeout, or DNS resolution error.
 */
export class NetworkError extends ParseError {
  constructor(platform: string, message: string = '网络连接失败') {
    super('network', platform, message)
    this.name = 'NetworkError'
  }

  override isRetryable(): boolean {
    return true
  }
}

/**
 * Verification required error (e.g., CAPTCHA, slider verification).
 * Common on platforms like Xiaohongshu.
 */
export class VerifyError extends ParseError {
  public readonly verifyType?: string

  constructor(platform: string, message: string = '需要人机验证', verifyType?: string) {
    super('need_verify', platform, message)
    this.name = 'VerifyError'
    this.verifyType = verifyType
  }

  override isRetryable(): boolean {
    return false
  }

  override toUserMessage(): string {
    return `${this.message}，请稍后再试或手动访问链接`
  }
}

/**
 * Invalid response error.
 * The server returned unexpected data format.
 */
export class InvalidResponseError extends ParseError {
  constructor(platform: string, message: string = '服务器返回数据格式异常') {
    super('invalid_response', platform, message)
    this.name = 'InvalidResponseError'
  }

  override isRetryable(): boolean {
    return true
  }
}

/**
 * Private/Restricted content error.
 * The content is private or age-restricted.
 */
export class PrivateContentError extends ParseError {
  constructor(platform: string, message: string = '内容为私密或受限状态') {
    super('private_content', platform, message)
    this.name = 'PrivateContentError'
  }

  override isRetryable(): boolean {
    return false
  }
}

/**
 * Geo-restricted content error.
 * The content is not available in the user's region.
 */
export class GeoRestrictedError extends ParseError {
  constructor(platform: string, message: string = '内容在当前地区不可用') {
    super('geo_restricted', platform, message)
    this.name = 'GeoRestrictedError'
  }

  override isRetryable(): boolean {
    return false
  }
}

/**
 * Helper function to detect error type from HTTP response.
 */
export function detectHttpError(
  platform: string,
  status: number,
  message?: string
): ParseError {
  if (status === 429) {
    return new RateLimitError(platform, message)
  }
  if (status === 401 || status === 403) {
    return new AuthError(platform, message)
  }
  if (status === 404) {
    return new NotFoundError(platform, message)
  }
  if (status >= 500) {
    return new NetworkError(platform, message || '服务器错误')
  }
  return new ParseError('http_error', platform, message || `HTTP ${status}`)
}

/**
 * Helper function to detect verification requirement from HTML content.
 */
export function detectVerifyRequirement(platform: string, html: string): VerifyError | null {
  const verifyKeywords = [
    '验证',
    'verify',
    'captcha',
    'slider',
    '人机验证',
    '安全验证',
    '请完成安全验证',
    '拖动滑块',
    '点击验证',
  ]

  const lowerHtml = html.toLowerCase()
  for (const keyword of verifyKeywords) {
    if (lowerHtml.includes(keyword.toLowerCase())) {
      return new VerifyError(platform, `${platform} 需要人机验证`, keyword)
    }
  }

  return null
}

/**
 * Type guard to check if an error is a ParseError.
 */
export function isParseError(error: unknown): error is ParseError {
  return error instanceof ParseError
}

/**
 * Type guard to check if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ParseError) {
    return error.isRetryable()
  }
  // For generic errors, check common retryable patterns
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes('network')
      || message.includes('timeout')
      || message.includes('429')
      || message.includes('rate limit')
    )
  }
  return false
}