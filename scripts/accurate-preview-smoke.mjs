import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { aggregateOwnedProcessSample, diffRoleCpuPercent } from './process-tree-metrics.mjs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
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

const whiteGlyph = (r, g, b, a) => a > 180 && r > 150 && g > 150 && b > 150
const redShadow = (r, g, b, a) => a > 120 && r > g + 5 && r > b + 2
const darkBackground = (r, g, b, a) => a > 180 && r < 45 && g < 45 && b < 45
const outlinePixel = (r, g, b, a) => a > 120 && Math.abs(r - 17) + Math.abs(g - 19) + Math.abs(b - 24) <= 45

const anchorPoint = (box, anchor) => {
  if (!box) return null
  return { x: box.centerX, y: anchor === 'top' ? box.top : anchor === 'middle' ? box.centerY : box.bottom }
}

const thickness = (white, outline) => white && outline ? {
  left: Math.max(0, white.left - outline.left),
  right: Math.max(0, outline.right - white.right),
  top: Math.max(0, white.top - outline.top),
  bottom: Math.max(0, outline.bottom - white.bottom),
  horizontal: (Math.max(0, white.left - outline.left) + Math.max(0, outline.right - white.right)) / 2,
  vertical: (Math.max(0, white.top - outline.top) + Math.max(0, outline.bottom - white.bottom)) / 2
} : null

const analyzeTransparentOverlay = (buffer) => {
  const image = decodePng(buffer)
  const visible = findBox(image, (_r, _g, _b, a) => a > 0, { x: 0, y: 0, width: image.width, height: image.height })
  const white = findBox(image, whiteGlyph, { x: 0, y: 0, width: image.width, height: image.height })
  const red = findBox(image, redShadow, { x: 0, y: 0, width: image.width, height: image.height })
  const background = findBox(image, darkBackground, { x: 0, y: 0, width: image.width, height: image.height })
  const cornerAlpha = image.pixels[3] ?? 0
  return {
    width: image.width,
    height: image.height,
    cornerAlpha,
    visiblePixels: visible ? visible.width * visible.height : 0,
    visible,
    white,
    red,
    background
  }
}

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
  const outlineRing = (box) => box ? { x: box.left - 18 * scaleX, y: box.top - 18 * scaleY, width: box.width + 36 * scaleX, height: box.height + 36 * scaleY } : scene
  const fastShadow = findBox(fast, redShadow, ring(fastWhite))
  const accurateShadow = findBox(accurate, redShadow, ring(accurateWhite))
  const fastBackground = findBox(fast, darkBackground, ring(fastWhite))
  const accurateBackground = findBox(accurate, darkBackground, ring(accurateWhite))
  const fastOutline = findBox(fast, outlinePixel, outlineRing(fastWhite))
  const accurateOutline = findBox(accurate, outlinePixel, outlineRing(accurateWhite))
  const widthDeltaRatio = fastWhite && accurateWhite ? Math.abs(fastWhite.width - accurateWhite.width) / Math.max(1, accurateWhite.width) : Infinity
  const heightDeltaRatio = fastWhite && accurateWhite ? Math.abs(fastWhite.height - accurateWhite.height) / Math.max(1, accurateWhite.height) : Infinity
  const centerDeltaPx = fastWhite && accurateWhite ? Math.hypot(fastWhite.centerX - accurateWhite.centerX, fastWhite.centerY - accurateWhite.centerY) : Infinity
  const fastAnchor = anchorPoint(fastWhite, report.subtitleSpec?.anchor)
  const accurateAnchor = anchorPoint(accurateWhite, report.subtitleSpec?.anchor)
  const anchorDeltaX = fastAnchor && accurateAnchor ? Math.abs(fastAnchor.x - accurateAnchor.x) : Infinity
  const anchorDeltaY = fastAnchor && accurateAnchor ? Math.abs(fastAnchor.y - accurateAnchor.y) : Infinity
  const expectedAnchor = report.subtitleSpec && report.sequence ? {
    x: scene.x + report.subtitleSpec.xPx / report.sequence.width * scene.width,
    y: scene.y + report.subtitleSpec.yPx / report.sequence.height * scene.height
  } : null
  const fastAnchorToSpec = fastAnchor && expectedAnchor ? { x: fastAnchor.x - expectedAnchor.x, y: fastAnchor.y - expectedAnchor.y } : null
  const accurateAnchorToSpec = accurateAnchor && expectedAnchor ? { x: accurateAnchor.x - expectedAnchor.x, y: accurateAnchor.y - expectedAnchor.y } : null
  const shadowWithinLimit = Boolean(fastShadow && accurateShadow && fastWhite && accurateWhite && fastShadow.width <= fastWhite.width * 2 && accurateShadow.width <= accurateWhite.width * 2)
  const heightTolerance = Number(report.subtitleSpec?.fontSizePx ?? 0) < 64 ? 0.25 : 0.15
  const result = {
    scene,
    fast: { white: fastWhite, outline: fastOutline, outlineThickness: thickness(fastWhite, fastOutline), shadow: fastShadow, background: fastBackground },
    accurate: { white: accurateWhite, outline: accurateOutline, outlineThickness: thickness(accurateWhite, accurateOutline), shadow: accurateShadow, background: accurateBackground },
    centerDeltaPx,
    widthDeltaRatio,
    heightDeltaRatio,
    heightTolerance,
    anchorDeltaX,
    anchorDeltaY,
    expectedAnchor,
    fastAnchorToSpec,
    accurateAnchorToSpec,
    outlineThicknessDelta: fastOutline && accurateOutline && thickness(fastWhite, fastOutline) && thickness(accurateWhite, accurateOutline) ? {
      horizontal: Math.abs(thickness(fastWhite, fastOutline).horizontal - thickness(accurateWhite, accurateOutline).horizontal),
      vertical: Math.abs(thickness(fastWhite, fastOutline).vertical - thickness(accurateWhite, accurateOutline).vertical)
    } : null,
    backgroundExpected: Number(report.subtitleSpec?.backgroundOpacity ?? 0) > 0,
    shadowExpected: Boolean(report.subtitleSpec?.shadowColor && !/^#(?:0{6}|0{8})$/iu.test(report.subtitleSpec.shadowColor)),
    shadowPresent: Boolean(fastShadow && accurateShadow),
    shadowWithinLimit,
    backgroundPresent: Boolean(fastBackground && accurateBackground),
    videoGeometryStable: JSON.stringify(report.fastVisual) === JSON.stringify(report.accurateVisual)
  }
  const outlineGate = Number(report.subtitleSpec?.fontSizePx ?? 0) >= 64 ? Boolean(fastOutline && accurateOutline) : true
  const shadowGate = result.shadowExpected ? Boolean(report.subtitleOverlayMetrics?.red) : true
  // During playback Fast Preview uses the same libass/FFmpeg layout authority
  // as Accurate/Final through a transparent PNG image overlay.
  const fastUsesCss = false
  const geometryGate = fastUsesCss
    ? centerDeltaPx <= 20 && anchorDeltaX <= 10 && anchorDeltaY <= 20
    : centerDeltaPx <= 20 && widthDeltaRatio <= 0.1 && heightDeltaRatio <= heightTolerance && anchorDeltaX <= 10 && anchorDeltaY <= 10
  if (!fastWhite || !accurateWhite || !geometryGate || !outlineGate || !shadowGate || (result.backgroundExpected && !result.backgroundPresent) || !result.videoGeometryStable) {
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

const readProcessMetrics = async (pid) => {
  if (!pid) return null
  try {
    if (process.platform === 'win32') {
      const command = `$root=${Number(pid)}; $cim=@{}; Get-CimInstance Win32_Process | ForEach-Object { $cim[[int]$_.ProcessId]=$_.ParentProcessId }; $owned=@($root); $changed=$true; while($changed){$changed=$false; foreach($item in $cim.GetEnumerator()){if($owned -contains [int]$item.Value -and $owned -notcontains [int]$item.Key){$owned+=[int]$item.Key;$changed=$true}}}; $rows=@(); foreach($id in $owned){try{$p=Get-Process -Id $id -ErrorAction Stop; $w=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\"; $rows+=[pscustomobject]@{pid=$id;parentPid=[int]$w.ParentProcessId;name=$w.Name;commandLine=$w.CommandLine;cpuSeconds=$p.CPU;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64}}catch{}}; $rows | ConvertTo-Json -Compress`
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, maxBuffer: 1024 * 1024 })
      const parsed = JSON.parse(result.stdout.trim() || '[]')
      return aggregateOwnedProcessSample(pid, Array.isArray(parsed) ? parsed : [parsed])
    }
    const result = await execFileAsync('ps', ['-o', 'cputime=,rss=', '-p', String(pid)])
    const [cpuTime, rss] = result.stdout.trim().split(/\s+/u)
    return aggregateOwnedProcessSample(pid, [{ pid, parentPid: 0, name: 'electron', commandLine: '', cpuSeconds: cpuTime ? cpuTime.split(':').reduce((total, value) => total * 60 + Number(value), 0) : 0, workingSetBytes: rss ? Number(rss) * 1024 : 0 }])
  } catch {
    return null
  }
}

const root = await mkdtemp(path.join(require('node:os').tmpdir(), 'spectra-accurate-preview-smoke-'))
try {
  const fixtureOverrides = process.env.SPECTRA_SUBTITLE_FIXTURE_JSON ? JSON.parse(process.env.SPECTRA_SUBTITLE_FIXTURE_JSON) : {}
  const sourceColor = process.env.SPECTRA_PREVIEW_SOURCE_COLOR
  const realVideo = process.env.SPECTRA_REAL_VIDEO_E2E === '1'
  const sourcePath = path.join(root, realVideo ? 'source.mp4' : 'source.png')
  const projectPath = path.join(root, 'project.json')
  await run(ffmpegPath, realVideo
    ? ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1920x1080:r=30:d=10', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sourcePath]
    : ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', sourceColor ? `color=c=${sourceColor}:s=1920x1080:r=30:d=1` : 'testsrc2=size=320x180:rate=30:duration=1', '-frames:v', '1', sourcePath])
  const mediaWidth = realVideo || sourceColor ? 1920 : 320
  const mediaHeight = realVideo || sourceColor ? 1080 : 180
  const defaultSubtitleStyle = { fontFamily: 'Noto Sans JP', fontSize: 123, color: '#ffffff', outlineColor: '#111318', outlineWidth: 14, shadowColor: '#ff0000', shadowBlur: 24, backgroundColor: '#000000', backgroundOpacity: 0.15, bold: true, italic: false, letterSpacing: 0, lineHeight: 1.15, alignment: 'bottom', positionX: 50, positionY: 86, maxWidthPercent: 80, animation: 'none', animationDurationUs: 0 }
  const subtitleStyle = { ...defaultSubtitleStyle, ...(fixtureOverrides.style ?? {}) }
  const subtitleText = typeof fixtureOverrides.text === 'string' ? fixtureOverrides.text : '字幕を入力'
  const fixtureTag = typeof fixtureOverrides.tag === 'string' ? fixtureOverrides.tag : 'base'
  const playbackMs = realVideo ? 10_500 : Number(process.env.SPECTRA_PREVIEW_PLAYBACK_MS ?? 200)
  const longPlayback = Number.isFinite(playbackMs) && playbackMs > 2_000
  const playbackDurationUs = longPlayback ? Math.ceil(playbackMs * 1_000) + 2_000_000 : 1_000_000
  const subtitleClips = realVideo
    ? [
        { id: 'caption-1', name: 'Cue 1', kind: 'subtitle', text: '実動画 cue 1', startUs: 500_000, durationUs: 2_000_000, sourceInUs: 0, enabled: true, style: subtitleStyle },
        { id: 'caption-2', name: 'Cue 2', kind: 'subtitle', text: '実動画 cue 2', startUs: 4_000_000, durationUs: 2_000_000, sourceInUs: 0, enabled: true, style: subtitleStyle },
        { id: 'caption-3', name: 'Cue 3', kind: 'subtitle', text: '実動画 animated cue', startUs: 7_000_000, durationUs: 2_000_000, sourceInUs: 0, enabled: true, style: { ...subtitleStyle, animation: 'pop', animationDurationUs: 500_000 } }
      ]
    : longPlayback
    ? Array.from({ length: Math.ceil(playbackDurationUs / 2_000_000) }, (_, index) => ({
        id: `caption-${index + 1}`, name: 'Caption', kind: 'subtitle', text: `${subtitleText} ${index + 1}`,
        startUs: 200_000 + index * 2_000_000, durationUs: 1_200_000, sourceInUs: 0, enabled: true, style: subtitleStyle
      }))
    : [{ id: 'caption-1', name: 'Caption', kind: 'subtitle', text: subtitleText, startUs: 200000, durationUs: 2000000, sourceInUs: 0, enabled: true, ...(Number.isSafeInteger(fixtureOverrides.maxLines) ? { maxLines: fixtureOverrides.maxLines } : {}), style: subtitleStyle }]
  const project = {
    schemaVersion: 1,
    appVersion: '0.1.0',
    id: `accurate-preview-smoke-${fixtureTag}`,
    name: `Accurate Preview Smoke ${fixtureTag}`,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    sequence: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#102030' },
    media: [{ id: 'source', name: realVideo ? 'source.mp4' : 'source.png', path: sourcePath, kind: realVideo ? 'video' : 'image', durationUs: realVideo ? 10_000_000 : 0, width: mediaWidth, height: mediaHeight, hasAudio: false, fileSize: 0, modifiedAt: '2026-08-14T00:00:00.000Z', offline: false }],
    tracks: [
      { id: 'video', name: 'V1', kind: 'video', locked: false, muted: false, hidden: false, clips: [{ id: 'video-1', name: 'Source', kind: realVideo ? 'video' : 'image', assetId: 'source', startUs: 0, durationUs: realVideo ? 10_000_000 : playbackDurationUs, sourceInUs: 0, enabled: true, transform: fixtureOverrides.transform ?? { positionX: 12, positionY: -8, scale: 0.9, rotation: 7, opacity: 0.82, crop: { left: 0.08, top: 0.04, right: 0.06, bottom: 0.1 } } }] },
      { id: 'subtitle', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false, clips: subtitleClips }
    ]
  }
  await writeFile(projectPath, JSON.stringify(project), 'utf8')
  const child = spawn(electronPath, ['.'], {
    cwd: repositoryRoot,
    env: { ...process.env, SPECTRA_ACCURATE_PREVIEW_SMOKE: '1', SPECTRA_PREVIEW_E2E_PROJECT: projectPath, SPECTRA_PREVIEW_PLAYBACK_MS: realVideo ? '10500' : process.env.SPECTRA_PREVIEW_PLAYBACK_MS, SPECTRA_REAL_VIDEO_E2E: realVideo ? '1' : undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  })
  let output = ''
  const processMetricSamples = []
  let metricReadInFlight = false
  const sampleProcessMetrics = async () => {
    if (metricReadInFlight) return
    metricReadInFlight = true
    try {
      const sample = await readProcessMetrics(child.pid)
      if (sample) processMetricSamples.push({ atMs: Date.now(), ...sample })
    } finally {
      metricReadInFlight = false
    }
  }
  await sampleProcessMetrics()
  const metricTimer = setInterval(() => { void sampleProcessMetrics() }, 500)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    const playbackMs = Number(process.env.SPECTRA_PREVIEW_PLAYBACK_MS ?? 200)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Accurate Preview smoke timed out.\n${output}`)) }, Math.max(60_000, playbackMs + 60_000))
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', async (code, signal) => { clearTimeout(timer); await sampleProcessMetrics(); signal ? reject(new Error(`Electron exited by ${signal}\n${output}`)) : resolve(code ?? 1) })
  })
  clearInterval(metricTimer)
  const line = output.split(/\r?\n/u).find((item) => item.startsWith('SPECTRA_ACCURATE_PREVIEW_REPORT '))
  if (!line) throw new Error(`Accurate Preview report was not emitted.\n${output}`)
  const report = JSON.parse(line.slice('SPECTRA_ACCURATE_PREVIEW_REPORT '.length))
  const productionOnly = Number(process.env.SPECTRA_PREVIEW_PLAYBACK_MS ?? 200) > 2_000
  if (exitCode !== 0 || report.error) throw new Error(`Accurate Preview smoke failed.\n${JSON.stringify(report)}\n${output}`)
  const [fastScreenshot, accurateScreenshot, overlayScreenshot, fastBuffer, accurateBuffer, overlayBuffer] = await Promise.all([
    stat(report.fastScreenshotPath),
    stat(report.accurateScreenshotPath),
    stat(report.subtitleOverlayFramePath),
    readFile(report.fastScreenshotPath),
    readFile(report.accurateScreenshotPath),
    readFile(report.subtitleOverlayFramePath)
  ])
  const subtitleOverlayMetrics = analyzeTransparentOverlay(overlayBuffer)
  report.subtitleOverlayMetrics = subtitleOverlayMetrics
  const elapsedSeconds = processMetricSamples.length > 1 ? (processMetricSamples.at(-1).atMs - processMetricSamples[0].atMs) / 1000 : 0
  const logicalCpus = Math.max(1, Number(require('node:os').cpus().length))
  const firstMetrics = processMetricSamples.find((sample) => sample.cpuSeconds > 0 || sample.workingSetBytes > 0) ?? processMetricSamples[0]
  const peakMetrics = processMetricSamples.reduce((peak, sample) => !peak || sample.cpuSeconds > peak.cpuSeconds ? sample : peak, null)
  const memoryByRole = processMetricSamples.reduce((peak, sample) => {
    for (const [role, value] of Object.entries(sample.workingSetBytesByRole ?? {})) peak[role] = Math.max(peak[role] ?? 0, Number(value) || 0)
    return peak
  }, {})
  const privateBytesByRole = processMetricSamples.reduce((peak, sample) => {
    for (const [role, value] of Object.entries(sample.privateBytesByRole ?? {})) peak[role] = Math.max(peak[role] ?? 0, Number(value) || 0)
    return peak
  }, {})
  const cpuPercentByRole = firstMetrics && peakMetrics ? diffRoleCpuPercent(firstMetrics.cpuByRole, peakMetrics.cpuByRole, elapsedSeconds, logicalCpus) : null
  report.productionMetrics = {
    cpuPercentByRole,
    cpuPercentTotal: cpuPercentByRole ? Object.values(cpuPercentByRole).reduce((total, value) => total + value, 0) : null,
    memoryWorkingSetBytesByRole: memoryByRole,
    memoryWorkingSetBytesTotal: Object.values(memoryByRole).reduce((total, value) => total + value, 0),
    privateBytesByRole,
    privateBytesTotal: Object.values(privateBytesByRole).reduce((total, value) => total + value, 0),
    ownedFfmpegProcessCountMax: Math.max(0, ...processMetricSamples.map((sample) => Number(sample.ffmpegProcessCount) || 0)),
    ownedProcessCountMax: Math.max(0, ...processMetricSamples.map((sample) => sample.ownedProcessIds?.length ?? 0)),
    samples: processMetricSamples.length
  }
  const shadowExpected = Boolean(report.subtitleSpec?.shadowColor && !/^#(?:0{6}|0{8})$/iu.test(report.subtitleSpec.shadowColor))
  if (!productionOnly && (!report.accurateInitial || !report.fastFixture || !report.fastSubtitleOverlay || !report.fastSubtitleOverlayReady || report.initialCssFallbackCount !== 0 || report.fastCssFallbackCount !== 0 || !report.accurateFixtureAfterResume || !report.editPendingRejectsStaleOverlay || !report.editedFrameReady || !report.fastDuringPlay || !report.accurateAfterResume || report.overlayCount !== 1 || report.initialOverlaySrc === report.editedOverlaySrc || fastScreenshot.size <= 0 || accurateScreenshot.size <= 0 || overlayScreenshot.size <= 0 || subtitleOverlayMetrics.cornerAlpha !== 0 || !subtitleOverlayMetrics.white || (shadowExpected && !subtitleOverlayMetrics.red) || !subtitleOverlayMetrics.background || report.consoleErrors?.length || report.loadFailure || report.renderProcessGone)) {
    throw new Error(`Accurate Preview DOM gate failed.\n${JSON.stringify(report)}\n${output}`)
  }
  const screenshotComparison = productionOnly ? null : analyzeScreenshots(fastBuffer, accurateBuffer, report)
  console.log(JSON.stringify({ ...report, fastScreenshotBytes: fastScreenshot.size, accurateScreenshotBytes: accurateScreenshot.size, screenshotComparison }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch((error) => {
    if (error?.code !== 'EBUSY') throw error
    console.warn(`Accurate Preview smoke fixture cleanup deferred: ${root}`)
  })
}
