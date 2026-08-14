import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const smokeScript = path.join(repositoryRoot, 'scripts', 'accurate-preview-smoke.mjs')

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const decodePng = (buffer) => {
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
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3
  const sourceStride = width * bytesPerPixel
  const pixels = Buffer.alloc(width * height * 4)
  const raw = inflateSync(Buffer.concat(idat))
  let source = 0
  let previous = Buffer.alloc(sourceStride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]
    const row = Buffer.alloc(sourceStride)
    for (let x = 0; x < sourceStride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
      const above = y > 0 ? previous[x] : 0
      const upperLeft = y > 0 && x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0
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
    previous = row
  }
  return { width, height, pixels }
}

const diffRegion = (left, right, region) => {
  let changed = 0
  let minX = region.x + region.width
  let minY = region.y + region.height
  let maxX = -1
  let maxY = -1
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(left.height, Math.ceil(region.y + region.height)); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(left.width, Math.ceil(region.x + region.width)); x += 1) {
      const at = (y * left.width + x) * 4
      const delta = Math.abs(left.pixels[at] - right.pixels[at]) + Math.abs(left.pixels[at + 1] - right.pixels[at + 1]) + Math.abs(left.pixels[at + 2] - right.pixels[at + 2])
      if (delta <= 8) continue
      changed += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return { changed, minX, minY, maxX, maxY, width: maxX >= 0 ? maxX - minX + 1 : 0, height: maxY >= 0 ? maxY - minY + 1 : 0 }
}

const simpleTransform = { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } }
const fixtures = [
  { tag: 'jp54-top', text: '字幕を入力', style: { fontFamily: 'Noto Sans JP', fontSize: 54, outlineWidth: 3, alignment: 'top', positionX: 25, positionY: 20, backgroundOpacity: 0.15 } },
  { tag: 'jp123-middle', text: '字幕を入力', style: { fontFamily: 'Noto Sans JP', fontSize: 123, outlineWidth: 14, alignment: 'middle', positionX: 50, positionY: 50, backgroundOpacity: 0.15 } },
  { tag: 'jp123-bottom', text: '字幕を入力', style: { fontFamily: 'Noto Sans JP', fontSize: 123, outlineWidth: 14, alignment: 'bottom', positionX: 75, positionY: 86, backgroundOpacity: 0.15 } },
  { tag: 'arial64-bottom', text: 'English subtitle', style: { fontFamily: 'Arial', fontSize: 64, outlineWidth: 6, alignment: 'bottom', positionX: 50, positionY: 86, backgroundOpacity: 0.15 } },
  { tag: 'bg-off', text: '字幕を入力', style: { fontFamily: 'Noto Sans JP', fontSize: 64, outlineWidth: 6, alignment: 'bottom', positionX: 50, positionY: 86, backgroundOpacity: 0 } },
  { tag: 'bg-on', text: '字幕を入力', style: { fontFamily: 'Noto Sans JP', fontSize: 64, outlineWidth: 6, alignment: 'bottom', positionX: 50, positionY: 86, backgroundOpacity: 0.15 } }
].map((fixture) => ({ ...fixture, style: { ...fixture.style, shadowColor: '#00000000', shadowBlur: 0 }, transform: simpleTransform }))

const runFixture = (fixture) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [smokeScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SPECTRA_SUBTITLE_FIXTURE_JSON: JSON.stringify(fixture),
      SPECTRA_PREVIEW_SOURCE_COLOR: '0x2090e0',
      SPECTRA_ACCURATE_PREVIEW_TAG: fixture.tag
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('exit', (code) => {
    if (code !== 0) return reject(new Error(`fixture ${fixture.tag} failed (${code})\n${stdout}\n${stderr}`))
    try {
      resolve(JSON.parse(stdout))
    } catch (error) {
      reject(new Error(`fixture ${fixture.tag} emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`))
    }
  })
})

const results = []
for (const fixture of fixtures) {
  const report = await runFixture(fixture)
  results.push({
    tag: fixture.tag,
    text: fixture.text,
    style: fixture.style,
    screenshots: { fast: report.fastScreenshotPath, accurate: report.accurateScreenshotPath },
    comparison: report.screenshotComparison
  })
}

console.log(JSON.stringify({ fixtures: results }, null, 2))

const backgroundOff = results.find((result) => result.tag === 'bg-off')
const backgroundOn = results.find((result) => result.tag === 'bg-on')
if (!backgroundOff || !backgroundOn) throw new Error('background A/B fixtures are missing')
const [backgroundOffPng, backgroundOnPng] = await Promise.all([
  readFile(backgroundOff.screenshots.accurate),
  readFile(backgroundOn.screenshots.accurate)
])
const off = decodePng(backgroundOffPng)
const on = decodePng(backgroundOnPng)
const white = backgroundOn.comparison.accurate.white
const backgroundDiff = diffRegion(off, on, { x: white.left - 80, y: white.top - 80, width: white.width + 160, height: white.height + 160 })
if (backgroundDiff.changed <= 100 || backgroundDiff.width <= 10 || backgroundDiff.height <= 10) {
  throw new Error(`Production Accurate background A/B gate failed: ${JSON.stringify(backgroundDiff)}`)
}
console.log(JSON.stringify({ backgroundAB: backgroundDiff }, null, 2))
