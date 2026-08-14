import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const ffmpegPath = require('ffmpeg-static')

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(`${command} exited with ${code ?? signal}\n${stdout}\n${stderr}`))
  })
})

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const decodePng = (buffer) => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('Expected PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || ![2, 6].includes(data[9])) throw new Error('Only 8-bit RGB/RGBA PNG is supported')
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (!width || !height || ![2, 6].includes(colorType)) throw new Error('Invalid PNG header')
  const raw = inflateSync(Buffer.concat(idat))
  const bytesPerPixel = colorType === 6 ? 4 : 3
  const sourceStride = width * bytesPerPixel
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  let source = 0
  let previousSourceRow = Buffer.alloc(sourceStride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]
    const sourceRow = Buffer.alloc(sourceStride)
    for (let x = 0; x < sourceStride; x += 1) {
      const value = raw[source++]
      const left = x >= bytesPerPixel ? sourceRow[x - bytesPerPixel] : 0
      const above = y > 0 ? previousSourceRow[x] : 0
      const upperLeft = y > 0 && x >= bytesPerPixel ? previousSourceRow[x - bytesPerPixel] : 0
      sourceRow[x] = (value + (filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0)) & 255
    }
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * bytesPerPixel
      const targetIndex = y * stride + x * 4
      pixels[targetIndex] = sourceRow[sourceIndex]
      pixels[targetIndex + 1] = sourceRow[sourceIndex + 1]
      pixels[targetIndex + 2] = sourceRow[sourceIndex + 2]
      pixels[targetIndex + 3] = colorType === 6 ? sourceRow[sourceIndex + 3] : 255
    }
    previousSourceRow = sourceRow
  }
  return { width, height, pixels }
}

const box = (image, predicate, region = { x: 0, y: 0, width: image.width, height: image.height }) => {
  let minX = region.x + region.width
  let minY = region.y + region.height
  let maxX = -1
  let maxY = -1
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(image.height, Math.ceil(region.y + region.height)); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(image.width, Math.ceil(region.x + region.width)); x += 1) {
      const index = (y * image.width + x) * 4
      if (!predicate(image.pixels[index], image.pixels[index + 1], image.pixels[index + 2], image.pixels[index + 3])) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 }
}

const white = (r, g, b, a) => a > 180 && r > 190 && g > 190 && b > 190
const red = (r, g, b, a) => a > 120 && r > g + 5 && r > b + 2

const main = async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'spectra-subtitle-parity-'))
  try {
    const previewPath = path.join(work, 'preview.png')
    const assPath = path.join(work, 'captions.ass')
    const finalPath = path.join(work, 'final.png')
    const electron = await run(electronPath, ['.'], {
      cwd: root,
      env: { ...process.env, SPECTRA_SUBTITLE_PARITY_SMOKE: '1', SPECTRA_PARITY_PREVIEW_PATH: previewPath, SPECTRA_PARITY_ASS_PATH: assPath }
    })
    const reportLine = `${electron.stdout}\n${electron.stderr}`.split(/\r?\n/u).find((line) => line.startsWith('SPECTRA_SUBTITLE_PARITY_REPORT '))
    if (!reportLine) throw new Error(`Parity report was not emitted\n${electron.stdout}\n${electron.stderr}`)
    const report = JSON.parse(reportLine.slice('SPECTRA_SUBTITLE_PARITY_REPORT '.length))
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x242a31:s=1920x1080:r=1:d=1', '-vf', `ass='${path.basename(assPath)}'`, '-frames:v', '1', finalPath], { cwd: work })
    const overlay = decodePng(await readFile(previewPath))
    const final = decodePng(await readFile(finalPath))
    const scaleX = overlay.width / report.viewport.width
    const scaleY = overlay.height / report.viewport.height
    const scene = { x: report.sceneRect.x * scaleX, y: report.sceneRect.y * scaleY, width: report.sceneRect.width * scaleX, height: report.sceneRect.height * scaleY }
    const overlayWhitePixels = box(overlay, white, scene)
    const overlayRedPixels = box(overlay, red, scene)
    const finalWhitePixels = box(final, white)
    const finalRedPixels = box(final, red)
    const finalBackground = box(final, (r, g, b, a) => a > 180 && r < 34 && g < 40 && b < 46)
    const normalize = (value, axis, size) => (value - (axis === 'x' ? scene.x : scene.y)) / (axis === 'x' ? scene.width : scene.height) * size
    const overlayWhite = overlayWhitePixels && { ...overlayWhitePixels, centerX: normalize(overlayWhitePixels.centerX, 'x', 1920), centerY: normalize(overlayWhitePixels.centerY, 'y', 1080) }
    const finalWhite = finalWhitePixels && { ...finalWhitePixels, centerX: finalWhitePixels.centerX, centerY: finalWhitePixels.centerY }
    const comparison = {
      overlay: { scene, textRect: report.textRect, white: overlayWhite, red: overlayRedPixels },
      final: { white: finalWhitePixels, red: finalRedPixels },
      whiteCenterDeltaPx: overlayWhite && finalWhite ? Math.hypot(overlayWhite.centerX - finalWhite.centerX, overlayWhite.centerY - finalWhite.centerY) : null,
      whiteGlyphReadable: Boolean(overlayWhite && finalWhite && overlayWhite.width > 3 && finalWhite.width > 3),
      redShadowPresent: Boolean(overlayRedPixels && finalRedPixels),
      backgroundGeometry: { previewTextRect: report.textRect, finalBackground, finalWhiteBox: finalWhitePixels }
    }
    if (!comparison.whiteGlyphReadable || !comparison.redShadowPresent || (comparison.whiteCenterDeltaPx ?? Infinity) > 180) {
      throw new Error(`Subtitle parity gate failed: ${JSON.stringify(comparison)}`)
    }
    console.log(JSON.stringify({ fixture: report.spec, comparison }, null, 2))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
