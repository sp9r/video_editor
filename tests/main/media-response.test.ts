import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMediaResponse } from '../../src/main/media-response.js'

describe('local media range responses', () => {
  let root: string
  let filePath: string
  let url: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'spectra-media-response-'))
    filePath = path.join(root, '動画 test.mp4')
    await writeFile(filePath, '0123456789')
    url = `spectra-media://local/${encodeURIComponent(filePath)}`
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('serves full files with their real length, MIME type and CORS headers', async () => {
    const response = await createMediaResponse(new Request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range')
    expect(response.headers.get('Content-Range')).toBeNull()
    expect(await response.text()).toBe('0123456789')
  })

  it.each([
    ['bytes=0-', '0123456789', 'bytes 0-9/10'],
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=8-100', '89', 'bytes 8-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-100', '0123456789', 'bytes 0-9/10'],
    ['bytes=9-9', '9', 'bytes 9-9/10'],
    ['bytes=0-999999999999999999999999', '0123456789', 'bytes 0-9/10']
  ])('serves exact byte range %s', async (range, expected, contentRange) => {
    const response = await createMediaResponse(new Request(url, { headers: { Range: range } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(contentRange)
    expect(response.headers.get('Content-Length')).toBe(String(expected.length))
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await response.text()).toBe(expected)
  })

  it.each(['bytes=10-', 'bytes=5-3', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-2', 'bytes=a-b', 'bytes=999999999999999999999-'])('rejects unsatisfiable or unsupported range %s', async (range) => {
    const response = await createMediaResponse(new Request(url, { headers: { Range: range } }))
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
    expect(response.headers.get('Content-Length')).toBe('0')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await response.text()).toBe('')
  })

  it.each([undefined, 'bytes=2-5'])('returns corresponding headers without streaming for HEAD (%s)', async (range) => {
    const response = await createMediaResponse(new Request(url, { method: 'HEAD', headers: range ? { Range: range } : undefined }))
    expect(response.status).toBe(range ? 206 : 200)
    expect(response.headers.get('Content-Length')).toBe(range ? '4' : '10')
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })

  it('serves zero-byte files and rejects ranges against them', async () => {
    await writeFile(filePath, '')
    const response = await createMediaResponse(new Request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('0')
    expect(response.body).toBeNull()
    const range = await createMediaResponse(new Request(url, { headers: { Range: 'bytes=0-' } }))
    expect(range.status).toBe(416)
    expect(range.headers.get('Content-Range')).toBe('bytes */0')
  })

  it.each([
    ['audio.WAV', 'audio/wav'], ['audio.m4a', 'audio/mp4'], ['audio.aac', 'audio/aac'], ['image.png', 'image/png'], ['image.jpeg', 'image/jpeg'], ['video.webm', 'video/webm']
  ])('returns the correct type for %s', async (name, contentType) => {
    const mediaPath = path.join(root, name)
    await writeFile(mediaPath, 'x')
    const response = await createMediaResponse(new Request(`spectra-media://local/${encodeURIComponent(mediaPath)}`))
    expect(response.headers.get('Content-Type')).toBe(contentType)
    expect(await response.text()).toBe('x')
  })

  it.each(['https://example.com/video.mp4', 'file:///video.mp4', 'spectra-media://external/video.mp4', 'spectra-media://local/relative.mp4', 'spectra-media://local/%ZZ'])('rejects external or invalid path %s', async (invalidUrl) => {
    const response = await createMediaResponse(new Request(invalidUrl))
    expect([403, 404]).toContain(response.status)
  })

  it('preserves extension and regular-file restrictions and missing-file errors', async () => {
    const blocked = path.join(root, 'private.txt')
    await writeFile(blocked, 'not media')
    expect((await createMediaResponse(new Request(`spectra-media://local/${encodeURIComponent(blocked)}`))).status).toBe(403)
    const directory = path.join(root, 'directory.mp4')
    await mkdir(directory)
    expect((await createMediaResponse(new Request(`spectra-media://local/${encodeURIComponent(directory)}`))).status).toBe(404)
    expect((await createMediaResponse(new Request(`spectra-media://local/${encodeURIComponent(path.join(root, 'missing.mp4'))}`))).status).toBe(404)
  })

  it('rejects methods other than GET and HEAD', async () => {
    const response = await createMediaResponse(new Request(url, { method: 'POST' }))
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET, HEAD')
  })

  it('allows cancellation of a streamed response', async () => {
    const response = await createMediaResponse(new Request(url))
    await expect(response.body?.cancel()).resolves.toBeUndefined()
  })
})
