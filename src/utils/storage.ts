import type { Context, Logger } from 'koishi'

let storageSeq = 0

/**
 * Try to store a buffer via `chatluna_storage` and return a servable URL.
 * Falls back to a base64 data URI when storage is unavailable or fails.
 */
export async function toMediaUrl(
  ctx: Context,
  mimeType: string,
  buffer: Buffer,
  hint: string,
  logger: Logger
): Promise<string> {
  const storage = (ctx as any).chatluna_storage
  if (!storage?.createTempFile) {
    return toDataUri(mimeType, buffer)
  }

  try {
    storageSeq += 1
    const ext = mimeToExt(mimeType)
    const filename = `smp_${hint}_${storageSeq}.${ext}`
    const file = await storage.createTempFile(buffer, filename)
    if (file?.url) {
      // Include sequence number in log to help identify duplicate calls
      logger.info(`storage: ${hint} #${storageSeq} -> ${file.url} (${buffer.length} bytes)`)
      return file.url
    }
  } catch (error: any) {
    logger.info(`storage fallback to base64: ${hint}: ${error?.message || error}`)
  }

  return toDataUri(mimeType, buffer)
}

export function toDataUri(mimeType: string, buffer: Buffer): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

function mimeToExt(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3'
  if (mime.includes('aac')) return 'aac'
  return 'bin'
}
