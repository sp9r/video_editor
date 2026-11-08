// Real-footage parity: paused canvas preview vs FFmpeg accurate frame vs frames decoded
// from a real export of the first N seconds of a user project.
//
//   npm run build
//   SPECTRA_PARITY_PROJECT=path\to\project.json node scripts/real-footage-parity-check.mjs
//   env: SPECTRA_PARITY_DPRS=1,2  SPECTRA_PARITY_RANGE_S=15  SPECTRA_PARITY_FRAMES=9,10,..
//
// Picture-frame proof with generated frame-counter media (no real footage needed):
//   SPECTRA_PARITY_SYNTH=1 node scripts/real-footage-parity-check.mjs
//   Source: untagged 1080p, 60 fps with drifting timestamps and dropped frames (VFR-like);
//   every picture frame carries its own index as a row of black/white blocks. Fails when the FFmpeg
//   accurate frame differs from the export, or the canvas differs by a source frame too often.
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const ffmpegPath = require('ffmpeg-static')
if (!existsSync(path.join(repositoryRoot, 'out', 'renderer', 'index.html'))) throw new Error('Renderer build is missing: run npm run build')
const synth = process.env.SPECTRA_PARITY_SYNTH === '1'
const projectPath = process.env.SPECTRA_PARITY_PROJECT
if (!synth && !projectPath) throw new Error('Set SPECTRA_PARITY_PROJECT to a project JSON file, or SPECTRA_PARITY_SYNTH=1')
const rangeSeconds = Number(process.env.SPECTRA_PARITY_RANGE_S ?? 15)
const dprs = (process.env.SPECTRA_PARITY_DPRS ?? '1,2').split(',').map(Number)
const port = 9300 + Math.floor(Math.random() * 500)
const GRID = { width: 640, height: 360 }
const dumpDir = process.env.SPECTRA_PARITY_DUMP
const [viewportWidth, viewportHeight] = (process.env.SPECTRA_PARITY_VIEWPORT ?? '1500x900').split('x').map(Number)
const viewport = { width: viewportWidth, height: viewportHeight }

// ---------- image helpers ----------
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
const decodePng = (buffer) => {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Expected PNG')
  let offset = 8, width = 0, height = 0, colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (data[8] !== 8 || ![2, 6].includes(data[9])) throw new Error('Only 8-bit RGB/RGBA PNG is supported')
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const pixels = Buffer.alloc(width * height * 4)
  const raw = inflateSync(Buffer.concat(idat))
  let source = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]
    const row = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? row[x - bpp] : 0
      const above = y > 0 ? previous[x] : 0
      const upperLeft = y > 0 && x >= bpp ? previous[x - bpp] : 0
      const value = raw[source++]
      row[x] = (value + (filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0)) & 255
    }
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4
      pixels[to] = row[x * bpp]; pixels[to + 1] = row[x * bpp + 1]; pixels[to + 2] = row[x * bpp + 2]
      pixels[to + 3] = colorType === 6 ? row[x * bpp + 3] : 255
    }
    previous = row
  }
  return { width, height, pixels }
}

/** Box-filter resample to a fixed comparison grid, composited over black. */
const resample = (image, width, height) => {
  const out = new Float64Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * image.height / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * image.height / height))
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * image.width / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * image.width / width))
      let r = 0, g = 0, b = 0, n = 0
      for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) {
        const o = (yy * image.width + xx) * 4
        const a = image.pixels[o + 3] / 255
        r += image.pixels[o] * a; g += image.pixels[o + 1] * a; b += image.pixels[o + 2] * a; n += 1
      }
      const o = (y * width + x) * 3
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n
    }
  }
  return out
}
const luma = (rgb) => {
  const out = new Float64Array(rgb.length / 3)
  for (let i = 0; i < out.length; i += 1) out[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]
  return out
}
const compare = (a, b, dims = GRID) => {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  const mae = sum / a.length
  // Signed mean per channel (canvas - FFmpeg): a constant offset means colour, not geometry.
  const bias = [0, 0, 0]
  for (let i = 0; i < a.length; i += 1) bias[i % 3] += (a[i] - b[i]) / (a.length / 3)
  let debiased = 0
  for (let i = 0; i < a.length; i += 1) debiased += Math.abs(a[i] - b[i] - bias[i % 3])
  const la = luma(a), lb = luma(b)
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2
  let total = 0, windows = 0
  for (let by = 0; by + 8 <= dims.height; by += 8) for (let bx = 0; bx + 8 <= dims.width; bx += 8) {
    let ma = 0, mb = 0
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) { const i = (by + y) * dims.width + bx + x; ma += la[i]; mb += lb[i] }
    ma /= 64; mb /= 64
    let va = 0, vb = 0, cov = 0
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) { const i = (by + y) * dims.width + bx + x; va += (la[i] - ma) ** 2; vb += (lb[i] - mb) ** 2; cov += (la[i] - ma) * (lb[i] - mb) }
    va /= 63; vb /= 63; cov /= 63
    total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    windows += 1
  }
  return { mae: Number(mae.toFixed(3)), ssim: Number((total / windows).toFixed(4)), colourBiasRGB: bias.map((v) => Number(v.toFixed(2))), maeWithoutBias: Number((debiased / a.length).toFixed(3)) }
}

// ---------- process helpers ----------
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)))
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  #socket; #next = 1; #pending = new Map(); errors = []
  static async connect(url) {
    const cdp = new Cdp()
    cdp.#socket = new WebSocket(url)
    await new Promise((resolve, reject) => { cdp.#socket.onopen = resolve; cdp.#socket.onerror = reject })
    cdp.#socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id && cdp.#pending.has(message.id)) {
        const { resolve, reject } = cdp.#pending.get(message.id)
        cdp.#pending.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : resolve(message.result)
      } else if (message.method === 'Runtime.exceptionThrown') cdp.errors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
      else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') cdp.errors.push(`console.error: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`)
    }
    return cdp
  }
  send(method, params = {}) {
    const id = this.#next++
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#socket.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`page eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value
  }
  close() { this.#socket.close() }
}


const readProjectFile = async () => JSON.parse(await readFile(projectPath, 'utf8'))

const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-real-parity-'))
let child
try {
  let full
  const BLOCKS = 15, BLOCK_PX = 128, SYNTH_FPS = 60, SYNTH_DRIFT = 1.00007
  if (synth) {
    const sourcePath = path.join(root, 'counter-1080p60.mp4')
    // Frame index N as 15 blocks (bit i = block i); every 37th frame dropped; timestamps drift against
    // the 30 fps grid so source frames land at every phase, never exactly on a half-frame tie.
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=1920x1080:r=${SYNTH_FPS}:d=24`,
      '-vf', `format=yuv420p,geq=lum='if(lt(Y,96),16+219*mod(floor(N/pow(2,floor(X/${BLOCK_PX}))),2),128)':cb=128:cr=128,select='mod(n+1,37)',setpts=PTS*${SYNTH_DRIFT}`,
      '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', sourcePath])
    const real = JSON.parse(await readFile(process.env.SPECTRA_PARITY_PROJECT ?? path.join(repositoryRoot, 'tests', 'fixtures', 'parity-clips.json'), 'utf8').catch(() => 'null') ?? 'null')
    // Off-grid clip starts and non-zero source-in values, as in a jump-cut edit.
    const cuts = real?.cuts ?? [[0, 288687, 0], [288687, 1504560, 1310000], [1793247, 1508630, 3410000], [3301877, 3051560, 5930000], [6353437, 2559400, 9740000], [8912837, 3800000, 12400000], [12712837, 2310600, 16300000]]
    full = {
      schemaVersion: 1, appVersion: '0.1.0', id: 'real-footage-parity-synth', name: 'Counter parity', createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      sequence: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 44100, backgroundColor: '#000000' },
      media: [{ id: 'counter', name: 'counter.mp4', path: sourcePath, kind: 'video', durationUs: 24_000_000, width: 1920, height: 1080, frameRate: { numerator: 5800, denominator: 100 }, hasAudio: false, fileSize: 0, modifiedAt: '2026-10-22T00:00:00.000Z', offline: false }],
      tracks: [{ id: 'v1', name: 'V1', kind: 'video', locked: false, muted: false, hidden: false, clips: cuts.map(([startUs, durationUs, sourceInUs], index) => ({ id: `c${index}`, name: `c${index}`, kind: 'video', assetId: 'counter', startUs, durationUs, sourceInUs, enabled: true, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 }, transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } } })) }]
    }
  } else full = await readProjectFile()
  const limitUs = rangeSeconds * 1_000_000
  const project = structuredClone(full)
  project.tracks = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => clip.startUs < limitUs).map((clip) => ({ ...clip, durationUs: Math.min(clip.durationUs, limitUs - clip.startUs) }))
  }))
  const fpsN = project.sequence.frameRate.numerator, fpsD = project.sequence.frameRate.denominator
  const fps = fpsN / fpsD
  const frameUs = (n) => Math.floor(n * 1_000_000 * fpsD / fpsN)
  const videoClips = project.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'video')
  const subs = project.tracks.filter((t) => t.kind === 'subtitle').flatMap((t) => t.clips)
  const hasSub = (n) => subs.some((s) => s.startUs <= frameUs(n) + 1 && frameUs(n) + 1 < s.startUs + s.durationUs)
  const cutFrames = videoClips.slice(1, 8).map((c) => Math.ceil(c.startUs * fpsN / fpsD / 1_000_000))
  const frames = process.env.SPECTRA_PARITY_FRAMES
    ? process.env.SPECTRA_PARITY_FRAMES.split(',').map(Number)
    : [...new Set([...cutFrames.flatMap((f) => [f, f + 1]), 40, 75, 140, 220, 300, 400].filter((f) => f >= 0 && f < rangeSeconds * fps - 2))].sort((a, b) => a - b)

  const output = []
  child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'profile')}`], {
    cwd: repositoryRoot, env: { ...process.env, SPECTRA_ACCURATE_PREVIEW_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => output.push(c)); child.stderr.on('data', (c) => output.push(c))
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await predicate().catch(() => null)
      if (value) return value
      await sleep(100)
    }
    throw new Error(`Timed out: ${label}\n${output.join('').slice(-1500)}`)
  }
  await waitFor(async () => output.join('').includes('SPECTRA_ACCURATE_PREVIEW_READY'), 60_000, 'app ready')
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((i) => i.type === 'page'), 20_000, 'devtools page')
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.eval(`window.__project = ${JSON.stringify(project)};
    window.__goto = (frame) => window.dispatchEvent(new CustomEvent('spectra:e2e-project', { detail: { project: window.__project, timeUs: Math.floor(frame * 1000000 * ${fpsD} / ${fpsN}) + 1 } }));
    window.__canvas = () => document.querySelector('canvas.preview-canvas');
    window.__state = () => { const c = window.__canvas(); return { frame: c?.dataset.drawnFrame, subtitleExact: c?.dataset.subtitleExact, layersReady: c?.dataset.layersReady, width: c?.width, height: c?.height } };
    window.__progress = []; window.spectra.onExportProgress((p) => window.__progress.push(p)); true`)

  // ---------- export the range once ----------
  const exportPath = path.join(root, 'export.mp4')
  const exportStarted = Date.now()
  await cdp.eval(`window.spectra.startExport(window.__project, ${JSON.stringify({ outputPath: exportPath, width: project.sequence.width, height: project.sequence.height, frameRate: project.sequence.frameRate, videoBitrate: 25_000_000, audioBitrate: 192_000, encoderMode: 'software', burnSubtitles: true, exportSrt: false })}).then((r) => r.jobId)`)
  const finalProgress = await waitFor(async () => cdp.eval(`window.__progress.find((p) => ['completed','failed','cancelled'].includes(p.stage)) ?? null`), 600_000, 'export')
  if (finalProgress.stage !== 'completed') throw new Error(`export ${finalProgress.stage}: ${finalProgress.error ?? ''}`)
  const exportSeconds = Number(((Date.now() - exportStarted) / 1000).toFixed(1))

  const exportFrame = async (n) => {
    const out = path.join(root, `exp-${n}.png`)
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', exportPath, '-vf', `select=eq(n\\,${n}),scale=in_range=tv:in_color_matrix=bt709:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba`, '-frames:v', '1', out])
    if (dumpDir) await copyFile(out, path.join(dumpDir, `f${n}-export.png`))
    return decodePng(await readFile(out))
  }
  const grid = (image) => resample(image, GRID.width, GRID.height)
  const goto = async (frame) => {
    await cdp.eval(`window.__goto(${frame})`)
    await waitFor(async () => {
      const s = await cdp.eval('window.__state()')
      return s.frame === String(frame) && s.subtitleExact === 'true' && s.layersReady === 'true'
    }, 60_000, `canvas settled at frame ${frame}`)
    await sleep(300)
  }
  let dumpTag = ''
  const grabCanvas = async () => {
    const bytes = Buffer.from((await cdp.eval(`window.__canvas().toDataURL('image/png')`)).split(',')[1], 'base64')
    if (dumpDir) await writeFile(path.join(dumpDir, `f${dumpTag}-canvas.png`), bytes)
    return decodePng(bytes)
  }
  const accurate = async (frame) => {
    const r = await cdp.eval(`window.spectra.renderAccuratePreviewFrame(window.__project, ${frameUs(frame) + 1}).then((x) => ({ framePath: x.framePath, frameIndex: x.frameIndex }))`)
    if (r.frameIndex !== frame) throw new Error(`FFmpeg rendered frame ${r.frameIndex}, expected ${frame}`)
    if (dumpDir) await copyFile(r.framePath, path.join(dumpDir, `f${frame}-accurate.png`))
    return decodePng(await readFile(r.framePath))
  }

  if (synth) {
    // Counter of every exported frame: the top 64 rows averaged to one value per block.
    const rawPath = path.join(root, 'export-counters.raw')
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', exportPath, '-vf', `scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=gray,crop=${BLOCKS * BLOCK_PX}:64:0:0,scale=${BLOCKS}:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', rawPath])
    const raw = await readFile(rawPath)
    const decodeBits = (get) => { let value = 0; for (let i = 0; i < BLOCKS; i += 1) if (get(i) > 128) value += 2 ** i; return value }
    const exportCounters = []
    for (let n = 0; n * BLOCKS < raw.length; n += 1) exportCounters.push(decodeBits((i) => raw[n * BLOCKS + i]))
    const imageCounter = (image) => {
      const scale = Math.min(image.width / 1920, image.height / 1080)
      const offsetX = (image.width - 1920 * scale) / 2, offsetY = (image.height - 1080 * scale) / 2
      return decodeBits((i) => {
        let sum = 0, n = 0
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
          const x = Math.round(offsetX + (i + 0.5) * BLOCK_PX * scale + dx), y = Math.round(offsetY + 32 * scale + dy)
          const o = (y * image.width + x) * 4
          sum += (image.pixels[o] + image.pixels[o + 1] + image.pixels[o + 2]) / 3; n += 1
        }
        return sum / n
      })
    }
    const sampled = new Set()
    for (const clip of videoClips) {
      const first = Math.ceil(clip.startUs * fpsN / fpsD / 1_000_000)
      for (const f of [first, first + 1, first + 2, first + 9, first + 10, first + 11, first + 17]) sampled.add(f)
    }
    const synthFrames = [...sampled].filter((f) => f < exportCounters.length).sort((a, b) => a - b)
    const synthRows = []
    for (const frame of synthFrames) {
      const accurateCounter = imageCounter(await accurate(frame))
      const perDpr = {}
      for (const dpr of dprs) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: false })
        await cdp.eval(`window.dispatchEvent(new Event('resize')); true`)
        await goto(frame)
        perDpr[dpr] = imageCounter(await grabCanvas())
      }
      // Where the preview parked its video element (seconds), for diagnosing a frame that is off by one.
      const videoTimes = await cdp.eval(`Array.from(document.querySelectorAll('video')).map((v) => v.currentTime)`)
      synthRows.push({ frame, exportCounter: exportCounters[frame], accurateCounter, canvasCounter: perDpr, previewVideoTimes: videoTimes })
    }
    const mismatches = synthRows.filter((r) => r.accurateCounter !== r.exportCounter || dprs.some((d) => r.canvasCounter[d] !== r.exportCounter))
    // Source-frame distance in 60 fps frames (positive: ahead of the export).
    const worst = Math.max(0, ...synthRows.flatMap((r) => [Math.abs(r.accurateCounter - r.exportCounter), ...dprs.map((d) => Math.abs(r.canvasCounter[d] - r.exportCounter))]))
    console.log(JSON.stringify({ exportFrames: exportCounters.length, sampledFrames: synthRows.length, mismatchCount: mismatches.length, worstSourceFrameDistance: worst, mismatches, rows: synthRows, jsErrors: cdp.errors }, null, 1))
    cdp.close()
    // FFmpeg's accurate frame must equal the export exactly. Chromium may leave out the odd source frame
    // after a seek (seen on this generated file: it never presents a few frames at all), so the canvas may
    // differ from the export by one source frame on at most 10% of the sampled frames.
    const accurateMismatches = synthRows.filter((r) => r.accurateCounter !== r.exportCounter)
    const canvasBudget = Math.ceil(synthRows.length * Number(process.env.SPECTRA_PARITY_CANVAS_BUDGET ?? 0.1))
    const canvasMismatches = mismatches.filter((r) => dprs.some((d) => r.canvasCounter[d] !== r.exportCounter))
    if (accurateMismatches.length || canvasMismatches.length > canvasBudget || worst > 1 || cdp.errors.length) process.exitCode = 1
  } else {
  // Compare at the canvas's own pixel size: the box-filtered FFmpeg frame is what a viewer of that
  // size would see, so differences are not an artefact of resampling the canvas up.
  const expCache = new Map()
  const exp = async (n) => {
    if (n < 0) return null
    if (!expCache.has(n)) expCache.set(n, await exportFrame(n))
    for (const key of expCache.keys()) if (key < n - 2) expCache.delete(key)
    return expCache.get(n)
  }
  const rows = []
  for (const frame of frames) {
    const accurateImage = await accurate(frame)
    const neighbourImages = [await exp(frame - 1), await exp(frame), await exp(frame + 1)]
    const pick = (g, dims) => {
      const maes = neighbourImages.map((n) => (n ? compare(g, resample(n, dims.width, dims.height), dims).mae : Infinity))
      return frame - 1 + maes.indexOf(Math.min(...maes))
    }
    const exportGrid = resample(neighbourImages[1], GRID.width, GRID.height)
    const accurateGrid = resample(accurateImage, GRID.width, GRID.height)
    const row = { frame, subtitle: hasSub(frame), accurateShowsExportFrame: pick(accurateGrid, GRID), accurateVsExport: compare(accurateGrid, exportGrid), dpr: {} }
    for (const dpr of dprs) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: false })
      await cdp.eval(`window.dispatchEvent(new Event('resize')); true`)
      await goto(frame)
      dumpTag = `${frame}-dpr${dpr}`
      const canvasImage = await grabCanvas()
      const dims = { width: canvasImage.width, height: canvasImage.height }
      const canvasGrid = resample(canvasImage, dims.width, dims.height)
      const exportAtCanvas = resample(neighbourImages[1], dims.width, dims.height)
      row.dpr[dpr] = {
        canvasPx: `${dims.width}x${dims.height}`,
        canvasShowsExportFrame: pick(canvasGrid, dims),
        canvasVsExport: compare(canvasGrid, exportAtCanvas, dims),
        canvasVsAccurate: compare(canvasGrid, resample(accurateImage, dims.width, dims.height), dims)
      }
    }
    rows.push(row)
  }
  const mean = (values) => Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3))
  const summary = {}
  for (const dpr of dprs) {
    const list = rows.map((r) => r.dpr[dpr])
    summary[`dpr${dpr}`] = {
      canvasVsExportMae: mean(list.map((r) => r.canvasVsExport.mae)), canvasVsExportSsim: mean(list.map((r) => r.canvasVsExport.ssim)),
      canvasVsExportBias: [0, 1, 2].map((c) => mean(list.map((r) => r.canvasVsExport.colourBiasRGB[c]))),
      canvasVsAccurateMae: mean(list.map((r) => r.canvasVsAccurate.mae)), canvasVsAccurateSsim: mean(list.map((r) => r.canvasVsAccurate.ssim)),
      wrongPictureFrames: rows.filter((r, i) => list[i].canvasShowsExportFrame !== r.frame).map((r) => r.frame)
    }
  }
  summary.accurateVsExport = {
    mae: mean(rows.map((r) => r.accurateVsExport.mae)), ssim: mean(rows.map((r) => r.accurateVsExport.ssim)),
    bias: [0, 1, 2].map((c) => mean(rows.map((r) => r.accurateVsExport.colourBiasRGB[c]))),
    wrongPictureFrames: rows.filter((r) => r.accurateShowsExportFrame !== r.frame).map((r) => r.frame)
  }
  console.log(JSON.stringify({ exportSeconds, frames: rows.length, summary, rows, jsErrors: cdp.errors }, null, 1))
  cdp.close()
  }
} finally {
  if (child && child.exitCode === null) { child.kill(); await sleep(1000) }
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => undefined)
}
