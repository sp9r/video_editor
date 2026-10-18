import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const mediaTypes: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff'
}

const corsHeaders = (): Headers => new Headers({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
  'Accept-Ranges': 'bytes'
})

const emptyResponse = (status: number, headers = corsHeaders()): Response => {
  headers.set('Content-Length', '0')
  return new Response(null, { status, headers })
}

/** A bounded single byte range; multipart and malformed ranges are rejected. */
const requestedRange = (value: string, size: number): { start: number; end: number } | null => {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const lastByte = BigInt(size - 1)
  if (!match[1]) {
    const suffix = BigInt(match[2]!)
    if (suffix === 0n) return null
    return { start: suffix > BigInt(size) ? 0 : size - Number(suffix), end: size - 1 }
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : lastByte
  if (start > lastByte || end < start) return null
  return { start: Number(start), end: Number(end > lastByte ? lastByte : end) }
}

/** Serve local media without relying on file:// transport's missing range headers. */
export const createMediaResponse = async (request: Request): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const headers = corsHeaders()
    headers.set('Allow', 'GET, HEAD')
    return emptyResponse(405, headers)
  }
  try {
    const url = new URL(request.url)
    if (url.protocol !== 'spectra-media:' || url.hostname !== 'local' || url.username || url.password || url.port) return emptyResponse(403)
    const filePath = decodeURIComponent(url.pathname.replace(/^\//u, ''))
    const contentType = mediaTypes[path.extname(filePath).toLowerCase()]
    if (!path.isAbsolute(filePath) || !contentType) return emptyResponse(403)
    const info = await stat(filePath)
    if (!info.isFile()) return emptyResponse(404)
    const headers = corsHeaders()
    headers.set('Content-Type', contentType)
    const rangeHeader = request.headers.get('Range')
    const range = rangeHeader === null ? undefined : requestedRange(rangeHeader, info.size)
    if (range === null) {
      headers.set('Content-Range', `bytes */${info.size}`)
      return emptyResponse(416, headers)
    }
    const start = range?.start ?? 0
    const end = range?.end ?? info.size - 1
    headers.set('Content-Length', String(Math.max(0, end - start + 1)))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
    const status = range ? 206 : 200
    if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers })
    const stream = createReadStream(filePath, { start, end, signal: request.signal })
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
  } catch {
    return emptyResponse(404)
  }
}
