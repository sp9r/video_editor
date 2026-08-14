import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const ffmpegPath = require('ffmpeg-static')
const rendererIndex = path.join(repositoryRoot, 'out', 'renderer', 'index.html')
if (!existsSync(rendererIndex)) throw new Error(`Renderer build is missing: ${rendererIndex}`)

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const decodePng = (buffer) => {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Expected PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || ![2, 6].includes(data[9])) throw new Error('Only 8-bit RGB/RGBA PNG is supported')
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3
  const sourceStride = width * bytesPerPixel
  const pixels = Buffer.alloc(width * height * 4)
  const raw = inflateSync(Buffer.concat(idat))
  let source = 0
  let previousRow = Buffer.alloc(sourceStride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]
    const row = Buffer.alloc(sourceStride)
    for (let x = 0; x < sourceStride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
      const above = y > 0 ? previousRow[x] : 0
      const upperLeft = y > 0 && x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0
      const value = raw[source++]
      row[x] = (value + (filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0)) & 255
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * bytesPerPixel
      const to = (y * width + x) * 4
      pixels[to] = row[from]
      pixels[to + 1] = row[from + 1]
      pixels[to + 2] = row[from + 2]
      pixels[to + 3] = colorType === 6 ? row[from + 3] : 255
    }
    previousRow = row
  }
  return { width, height, pixels }
}

const findBox = (image, predicate, region) => {
  let left = region.x + region.width
  let top = region.y + region.height
  let right = -1
  let bottom = -1
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(image.height, Math.ceil(region.y + region.height)); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(image.width, Math.ceil(region.x + region.width)); x += 1) {
      const offset = (y * image.width + x) * 4
      if (!predicate(image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2], image.pixels[offset + 3])) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return right < 0 ? null : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, centerX: (left + right) / 2, centerY: (top + bottom) / 2 }
}

const whiteGlyph = (r, g, b, a) => a > 180 && r > 190 && g > 190 && b > 190
const redShadow = (r, g, b, a) => a > 120 && r > g + 5 && r > b + 2
const darkBackground = (r, g, b, a) => a > 180 && r < 45 && g < 45 && b < 45

const analyzeScreenshots = (fastBuffer, accurateBuffer, report) => {
  const fast = decodePng(fastBuffer)
  const accurate = decodePng(accurateBuffer)
  const scaleX = fast.width / report.viewport.width
  const scaleY = fast.height / report.viewport.height
  const scene = {
    x: report.fastVisual.x * scaleX,
    y: report.fastVisual.y * scaleY,
    width: report.fastVisual.width * scaleX,
    height: report.fastVisual.height * scaleY
  }
  const fastWhite = findBox(fast, whiteGlyph, scene)
  const accurateWhite = findBox(accurate, whiteGlyph, scene)
  const ring = (box) => box ? { x: box.left - 80 * scaleX, y: box.top - 80 * scaleY, width: box.width + 160 * scaleX, height: box.height + 160 * scaleY } : scene
  const fastShadow = findBox(fast, redShadow, ring(fastWhite))
  const accurateShadow = findBox(accurate, redShadow, ring(accurateWhite))
  const fastBackground = findBox(fast, darkBackground, ring(fastWhite))
  const accurateBackground = findBox(accurate, darkBackground, ring(accurateWhite))
  const widthDeltaRatio = fastWhite && accurateWhite ? Math.abs(fastWhite.width - accurateWhite.width) / Math.max(1, accurateWhite.width) : Infinity
  const heightDeltaRatio = fastWhite && accurateWhite ? Math.abs(fastWhite.height - accurateWhite.height) / Math.max(1, accurateWhite.height) : Infinity
  const centerDeltaPx = fastWhite && accurateWhite ? Math.hypot(fastWhite.centerX - accurateWhite.centerX, fastWhite.centerY - accurateWhite.centerY) : Infinity
  const shadowWithinLimit = Boolean(fastShadow && accurateShadow && fastShadow.width <= fastWhite.width * 2 && accurateShadow.width <= accurateWhite.width * 2)
  const result = {
    scene,
    fast: { white: fastWhite, shadow: fastShadow, background: fastBackground },
    accurate: { white: accurateWhite, shadow: accurateShadow, background: accurateBackground },
    centerDeltaPx,
    widthDeltaRatio,
    heightDeltaRatio,
    shadowPresent: Boolean(fastShadow && accurateShadow),
    shadowWithinLimit,
    backgroundPresent: Boolean(fastBackground && accurateBackground),
    videoGeometryStable: JSON.stringify(report.fastVisual) === JSON.stringify(report.accurateVisual)
  }
  if (!fastWhite || !accurateWhite || centerDeltaPx > 20 || widthDeltaRatio > 0.1 || heightDeltaRatio > 0.15 || !result.shadowPresent || !shadowWithinLimit || !result.backgroundPresent || !result.videoGeometryStable) {
    throw new Error(`Fast/accurate screenshot parity gate failed: ${JSON.stringify(result)}`)
  }
  return result
}

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}`)))
})

const root = await mkdtemp(path.join(require('node:os').tmpdir(), 'spectra-accurate-preview-smoke-'))
try {
  const sourcePath = path.join(root, 'source.png')
  const projectPath = path.join(root, 'project.json')
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
    '-frames:v', '1', sourcePath
  ])
  const project = {
    schemaVersion: 1,
    appVersion: '0.1.0',
    id: 'accurate-preview-smoke',
    name: 'Accurate Preview Smoke',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    sequence: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#102030' },
    media: [{ id: 'source', name: 'source.png', path: sourcePath, kind: 'image', durationUs: 0, width: 320, height: 180, hasAudio: false, fileSize: 0, modifiedAt: '2026-08-14T00:00:00.000Z', offline: false }],
    tracks: [
      { id: 'video', name: 'V1', kind: 'video', locked: false, muted: false, hidden: false, clips: [{ id: 'video-1', name: 'Source', kind: 'image', assetId: 'source', startUs: 0, durationUs: 1000000, sourceInUs: 0, enabled: true, transform: { positionX: 12, positionY: -8, scale: 0.9, rotation: 7, opacity: 0.82, crop: { left: 0.08, top: 0.04, right: 0.06, bottom: 0.1 } } }] },
      { id: 'subtitle', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false, clips: [{ id: 'caption-1', name: 'Caption', kind: 'subtitle', text: '字幕を入力', startUs: 200000, durationUs: 600000, sourceInUs: 0, enabled: true, style: { fontFamily: 'Noto Sans JP', fontSize: 123, color: '#ffffff', outlineColor: '#111318', outlineWidth: 14, shadowColor: '#ff0000', shadowBlur: 24, backgroundColor: '#000000', backgroundOpacity: 0.15, bold: true, italic: false, letterSpacing: 0, lineHeight: 1.15, alignment: 'bottom', positionX: 50, positionY: 86, maxWidthPercent: 80, animation: 'none', animationDurationUs: 0 } }] }
    ]
  }
  await writeFile(projectPath, JSON.stringify(project), 'utf8')
  const child = spawn(electronPath, ['.'], {
    cwd: repositoryRoot,
    env: { ...process.env, SPECTRA_ACCURATE_PREVIEW_SMOKE: '1', SPECTRA_PREVIEW_E2E_PROJECT: projectPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Accurate Preview smoke timed out.\n${output}`)) }, 25_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(`Electron exited by ${signal}\n${output}`)) : resolve(code ?? 1) })
  })
  const line = output.split(/\r?\n/u).find((item) => item.startsWith('SPECTRA_ACCURATE_PREVIEW_REPORT '))
  if (!line) throw new Error(`Accurate Preview report was not emitted.\n${output}`)
  const report = JSON.parse(line.slice('SPECTRA_ACCURATE_PREVIEW_REPORT '.length))
  if (exitCode !== 0 || report.error) throw new Error(`Accurate Preview smoke failed.\n${JSON.stringify(report)}\n${output}`)
  const [fastScreenshot, accurateScreenshot, fastBuffer, accurateBuffer] = await Promise.all([
    stat(report.fastScreenshotPath),
    stat(report.accurateScreenshotPath),
    readFile(report.fastScreenshotPath),
    readFile(report.accurateScreenshotPath)
  ])
  if (!report.accurateInitial || !report.fastFixture || !report.accurateFixtureAfterResume || !report.editPendingPreservesOverlay || !report.editedFrameReady || !report.fastDuringPlay || !report.overlayImmediatelyAfterPause || !report.accurateAfterResume || report.overlayCount !== 1 || report.initialOverlaySrc === report.editedOverlaySrc || fastScreenshot.size <= 0 || accurateScreenshot.size <= 0 || report.consoleErrors?.length || report.loadFailure || report.renderProcessGone) {
    throw new Error(`Accurate Preview DOM gate failed.\n${JSON.stringify(report)}\n${output}`)
  }
  const screenshotComparison = analyzeScreenshots(fastBuffer, accurateBuffer, report)
  console.log(JSON.stringify({ ...report, fastScreenshotBytes: fastScreenshot.size, accurateScreenshotBytes: accurateScreenshot.size, screenshotComparison }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
