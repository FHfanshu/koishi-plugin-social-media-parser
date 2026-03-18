/**
 * Generic retry utility with exponential backoff.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number
  /** Base delay in milliseconds for exponential backoff */
  baseDelayMs: number
  /** Maximum delay cap in milliseconds (default: 60000) */
  maxDelayMs?: number
  /** Custom function to determine if error should trigger retry */
  shouldRetry?: (error: Error, attempt: number) => boolean
  /** Callback invoked on each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
}

const DEFAULT_MAX_DELAY_MS = 60_000

/**
 * Execute a function with automatic retry on failure using exponential backoff.
 *
 * Delay formula: baseDelay * 2^attempt + random(0, 1000)
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchData(),
 *   {
 *     maxRetries: 3,
 *     baseDelayMs: 2000,
 *     shouldRetry: (err) => err.message.includes('429'),
 *     onRetry: (attempt, err, delay) => console.log(`Retry ${attempt} after ${delay}ms: ${err.message}`)
 *   }
 * )
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options

  let lastError: Error = new Error('Unknown error')

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Check if we should retry
      if (attempt >= maxRetries || !shouldRetry(lastError, attempt)) {
        throw lastError
      }

      // Calculate delay with exponential backoff + jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt)
      const jitter = Math.random() * 1000
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs)

      // Notify callback
      if (onRetry) {
        onRetry(attempt + 1, lastError, delay)
      }

      // Wait before next attempt
      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Default retry condition: retry on network errors, timeouts, and 429/5xx status codes.
 */
function defaultShouldRetry(error: Error, _attempt: number): boolean {
  const message = error.message.toLowerCase()

  // Network errors
  if (
    message.includes('network')
    || message.includes('timeout')
    || message.includes('econnrefused')
    || message.includes('econnreset')
    || message.includes('enotfound')
    || message.includes('socket hang up')
  ) {
    return true
  }

  // HTTP status codes
  if (
    message.includes('429')
    || message.includes('rate limit')
    || message.includes('too many requests')
  ) {
    return true
  }

  // Server errors (5xx)
  if (/[45]\d\d/.test(message)) {
    return true
  }

  // Empty response
  if (message.includes('empty response') || message.includes('invalid json')) {
    return true
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a simple retry wrapper for a function.
 * Useful for wrapping existing async functions.
 */
export function createRetryWrapper<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: Omit<RetryOptions, 'onRetry'> & { onRetry?: (attempt: number, error: Error) => void }
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    return withRetry(
      () => fn(...args),
      {
        ...options,
        onRetry: options.onRetry
          ? (attempt, error, _delay) => options.onRetry!(attempt, error)
          : undefined,
      }
    )
  }
}