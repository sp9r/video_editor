// Real Electron parity check: the paused/playing canvas preview against FFmpeg's
// own frame for the same project. Drives the built app over the DevTools
// protocol; the app runs in smoke mode with an isolated temp profile.
//
//   npm run build
//   SPECTRA_REAL_VIDEO_E2E=1 SPECTRA_AUDIO_E2E=1 node scripts/accurate-preview-smoke.mjs
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

const maxMae = Number(process.env.SPECTRA_PARITY_MAX_MAE ?? 4)
const minSsim = Number(process.env.SPECTRA_PARITY_MIN_SSIM ?? 0.95)
const audioE2e = process.env.SPECTRA_AUDIO_E2E === '1'
const port = 9300 + Math.floor(Math.random() * 500)

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
const GRID = { width: 320, height: 180 }
const compare = (a, b) => {
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
  for (let by = 0; by + 8 <= GRID.height; by += 8) for (let bx = 0; bx + 8 <= GRID.width; bx += 8) {
    let ma = 0, mb = 0
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) { const i = (by + y) * GRID.width + bx + x; ma += la[i]; mb += lb[i] }
    ma /= 64; mb /= 64
    let va = 0, vb = 0, cov = 0
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) { const i = (by + y) * GRID.width + bx + x; va += (la[i] - ma) ** 2; vb += (lb[i] - mb) ** 2; cov += (la[i] - ma) * (lb[i] - mb) }
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

const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-parity-smoke-'))
let child
try {
  // ---------- fixture: two visual layers + subtitles with a fade ----------
  const bottomPath = path.join(root, 'bottom.mp4')
  const topPath = path.join(root, 'top.mp4')
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8',
    ...(audioE2e ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-c:a', 'aac'] : []),
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15', bottomPath])
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15', topPath])
  const style = { fontFamily: 'Noto Sans JP', fontSize: 72, color: '#ffffff', outlineColor: '#111318', outlineWidth: 6, shadowColor: '#ff0000', shadowBlur: 8, backgroundColor: '#000000', backgroundOpacity: 0.15, bold: true, italic: false, letterSpacing: 0, lineHeight: 1.15, alignment: 'bottom', positionX: 50, positionY: 86, maxWidthPercent: 80, animation: 'none', animationDurationUs: 0 }
  const media = (id, file, width, height, hasAudio) => ({ id, name: path.basename(file), path: file, kind: 'video', durationUs: 8_000_000, width, height, hasAudio, ...(hasAudio ? { channels: 1, sampleRate: 48000 } : {}), fileSize: 0, modifiedAt: '2026-08-14T00:00:00.000Z', offline: false })
  const subtitle = (id, text, startUs, durationUs, patch = {}) => ({ id, name: id, kind: 'subtitle', text, startUs, durationUs, sourceInUs: 0, enabled: true, style: { ...style, ...patch } })
  const project = {
    schemaVersion: 1, appVersion: '0.1.0', id: 'preview-parity-smoke', name: 'Preview Parity Smoke',
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    sequence: { width: 1280, height: 720, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#102030' },
    media: [media('bottom', bottomPath, 1280, 720, audioE2e), media('top', topPath, 640, 360, false)],
    tracks: [
      { id: 'v2', name: 'V2', kind: 'video', locked: false, muted: false, hidden: false, clips: [{ id: 'top-1', name: 'Top', kind: 'video', assetId: 'top', startUs: 0, durationUs: 8_000_000, sourceInUs: 0, enabled: true, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 }, transform: { positionX: 180, positionY: -70, scale: 0.8, rotation: 7, opacity: 0.9, crop: { left: 0.08, top: 0.04, right: 0.06, bottom: 0.1 } } }] },
      { id: 'v1', name: 'V1', kind: 'video', locked: false, muted: false, hidden: false, clips: [{ id: 'bottom-1', name: 'Bottom', kind: 'video', assetId: 'bottom', startUs: 0, durationUs: 8_000_000, sourceInUs: 0, enabled: true, audio: { volumeDb: audioE2e ? 6 : 0, pan: audioE2e ? 0.25 : 0, fadeInUs: 0, fadeOutUs: 0 }, transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } } }] },
      { id: 'sub', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false, clips: [
        subtitle('cue-static', '静的な字幕 cue 1', 502_000, 2_000_000),
        subtitle('cue-fade', 'フェードする字幕', 3_000_000, 2_000_000, { animation: 'fade', animationDurationUs: 500_000 }),
        subtitle('cue-pop', 'ポップする字幕', 5_500_000, 2_000_000, { animation: 'pop', animationDurationUs: 500_000 })
      ] }
    ]
  }

  // ---------- launch ----------
  const output = []
  child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`], {
    cwd: repositoryRoot,
    env: { ...process.env, SPECTRA_ACCURATE_PREVIEW_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => output.push(chunk)); child.stderr.on('data', (chunk) => output.push(chunk))
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await predicate().catch(() => null)
      if (value) return value
      await sleep(100)
    }
    throw new Error(`Timed out: ${label}\n${output.join('')}`)
  }
  await waitFor(async () => output.join('').includes('SPECTRA_ACCURATE_PREVIEW_READY'), 60_000, 'app ready')
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return list.find((item) => item.type === 'page')
  }, 20_000, 'devtools page')
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: Number(process.env.SPECTRA_PARITY_DPR ?? 2), mobile: false })
  await cdp.eval(`window.dispatchEvent(new Event('resize')); true`)
  await cdp.eval(`window.__project = ${JSON.stringify(project)};
    window.__goto = (frame) => window.dispatchEvent(new CustomEvent('spectra:e2e-project', { detail: { project: window.__project, timeUs: Math.floor(frame * 1000000 / 30) + 1 } }));
    window.__canvas = () => document.querySelector('canvas.preview-canvas');
    window.__state = () => { const c = window.__canvas(); return { frame: c?.dataset.drawnFrame, subtitleExact: c?.dataset.subtitleExact, layersReady: c?.dataset.layersReady, width: c?.width, height: c?.height } };
    true`)
  const goto = async (frame) => {
    await cdp.eval(`window.__goto(${frame})`)
    await waitFor(async () => {
      const state = await cdp.eval('window.__state()')
      return state.frame === String(frame) && state.subtitleExact === 'true' && state.layersReady === 'true'
    }, 20_000, `canvas settled at frame ${frame}`).catch(async (error) => {
      const detail = await cdp.eval(`(async () => { window.__goto(6); await new Promise((r) => setTimeout(r, 500)); const t = document.body.innerText; const i = t.indexOf('E2E'); return JSON.stringify({ info: await window.spectra.getAppInfo(), e2e: i >= 0 ? t.slice(i, i + 200) : null, state: window.__state(), pool: document.querySelector('.preview-source-pool')?.children.length }) })()`)
      throw new Error(`${error.message.slice(0, 60)} ${detail} errors=${cdp.errors.join("|")}`)
    })
    await sleep(250)
    // A late subtitle image or seek must not have changed the frame.
    const state = await cdp.eval('window.__state()')
    if (state.frame !== String(frame)) throw new Error(`frame drifted at ${frame}: ${JSON.stringify(state)}`)
  }
  const grabCanvas = async () => {
    const url = await cdp.eval(`window.__canvas().toDataURL('image/png')`)
    return decodePng(Buffer.from(url.split(',')[1], 'base64'))
  }
  const accurate = async (frame) => {
    const result = await cdp.eval(`window.spectra.renderAccuratePreviewFrame(window.__project, ${Math.floor(frame * 1_000_000 / 30) + 1}).then((r) => ({ framePath: r.framePath, frameIndex: r.frameIndex }))`)
    if (result.frameIndex !== frame) throw new Error(`FFmpeg rendered frame ${result.frameIndex}, expected ${frame}`)
    return { image: decodePng(await readFile(result.framePath)), framePath: result.framePath }
  }
  const check = async (label, frame) => {
    await goto(frame)
    const canvasUrl = await cdp.eval(`window.__canvas().toDataURL('image/png')`)
    const canvas = resample(decodePng(Buffer.from(canvasUrl.split(',')[1], 'base64')), GRID.width, GRID.height)
    const ffmpegResult = await accurate(frame)
    const ffmpeg = resample(ffmpegResult.image, GRID.width, GRID.height)
    if (process.env.SPECTRA_PARITY_DUMP) {
      await writeFile(path.join(process.env.SPECTRA_PARITY_DUMP, `f${frame}-canvas.png`), Buffer.from(canvasUrl.split(',')[1], 'base64'))
      await copyFile(ffmpegResult.framePath, path.join(process.env.SPECTRA_PARITY_DUMP, `f${frame}-ffmpeg.png`))
    }
    return { label, frame, timeSec: Number((frame / 30).toFixed(3)), ...compare(canvas, ffmpeg) }
  }

  // ---------- 1. paused canvas vs FFmpeg ----------
  await cdp.eval(`window.__goto(0)`)
  await waitFor(async () => (await cdp.eval('window.__state()')).frame === '0', 30_000, 'first frame')
  // Every planned subtitle image is rendered in the background without any playback.
  await waitFor(async () => {
    const progress = await cdp.eval(`window.__canvas()?.dataset.subtitleRendered ?? ''`)
    const [rendered, planned] = String(progress).split('/').map(Number)
    return planned > 0 && rendered === planned
  }, 60_000, 'subtitle pre-render')
  const plan = [
    ['before any cue', 6], ['cue-static one frame early (off-grid start)', 15], ['cue-static first frame', 16], ['static cue', 30],
    ['cue-static last frame', 75], ['cue-static first frame after end', 76], ['gap after static cue', 87],
    ['fade-in start', 91], ['fade-in mid', 98], ['fade static', 120], ['fade-out mid', 142], ['fade-out end', 148],
    ['pop start', 166], ['pop mid', 172], ['after pop', 230]
  ]
  const paused = []
  for (const [label, frame] of plan) paused.push(await check(label, frame))
  // Rapid seeks must end on the right cue, not a stale one.
  for (const frame of [30, 87, 98, 240, 120, 6, 172]) await cdp.eval(`window.__goto(${frame})`)
  paused.push(await check('after rapid seeks (frame 172)', 172))
  paused.push(await check('step +1 (frame 173)', 173))
  paused.push(await check('step -2 (frame 171)', 171))

  // ---------- 2. playing vs paused ----------
  await cdp.eval(`window.__goto(84)`)
  await waitFor(async () => (await cdp.eval('window.__state()')).frame === '84', 20_000, 'frame 84')
  const playingSamples = await cdp.eval(`new Promise((resolve) => {
    document.querySelector('.play-button').click()
    const samples = []
    const started = performance.now()
    const timer = setInterval(() => {
      const c = window.__canvas(); const frame = Number(c.dataset.drawnFrame)
      if (c.dataset.layersReady === 'true' && c.dataset.subtitleExact === 'true' && !samples.some((s) => s.frame === frame)) samples.push({ frame, url: c.toDataURL('image/png') })
      if (performance.now() - started > 3500) { clearInterval(timer); document.querySelector('.play-button').click(); resolve(samples) }
    }, 40)
  })`)
  const audio = audioE2e ? await cdp.eval(`Array.from(document.querySelectorAll('.preview-audio-pool audio')).map((a) => ({ paused: a.paused, currentTime: a.currentTime, error: !!a.error }))`) : null
  const playing = []
  const picked = playingSamples.filter((_, index) => index % Math.max(1, Math.floor(playingSamples.length / 8)) === 0).slice(0, 8)
  for (const sample of picked) {
    const playingGrid = resample(decodePng(Buffer.from(sample.url.split(',')[1], 'base64')), GRID.width, GRID.height)
    await goto(sample.frame)
    const pausedGrid = resample(await grabCanvas(), GRID.width, GRID.height)
    const ffmpegGrid = resample((await accurate(sample.frame)).image, GRID.width, GRID.height)
    playing.push({ frame: sample.frame, playingVsPaused: compare(playingGrid, pausedGrid), playingVsFfmpeg: compare(playingGrid, ffmpegGrid) })
  }

  // ---------- overlay probe: does the transparent libass PNG keep the cue background box? ----------
  const overlayPath = await cdp.eval(`window.spectra.renderSubtitleOverlay(window.__project, 4000001, { animationMode: 'full' }).then((r) => r.framePath)`)
  const overlay = decodePng(await readFile(overlayPath))
  let faint = 0
  for (let i = 3; i < overlay.pixels.length; i += 4) if (overlay.pixels[i] > 0 && overlay.pixels[i] < 90) faint += 1
  const probeOffset = (Math.round(0.78 * overlay.height) * overlay.width + Math.round(0.36 * overlay.width)) * 4
  const overlayProbe = { width: overlay.width, height: overlay.height, faintAlphaPixels: faint, boxPixelRGBA: [...overlay.pixels.subarray(probeOffset, probeOffset + 4)] }

  // ---------- 3. hit test ----------
  await goto(30)
  const rect = await cdp.eval(`(() => { const r = window.__canvas().getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const click = async (fx, fy) => {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x + rect.w * fx, y: rect.y + rect.h * fy, button: 'left', clickCount: 1 })
    await sleep(250)
    return await cdp.eval(`(() => { const t = document.body.innerText; const i = t.indexOf('インスペクタ'); return t.slice(i, i + 40).replace(/\s+/g, ' ') })()`)
  }
  const hit = { bottomCorner: await click(0.03, 0.9), topLayer: await click(0.78, 0.4) }

  const failures = []
  for (const row of paused) if (row.mae > maxMae || row.ssim < minSsim) failures.push(`paused ${row.label} (frame ${row.frame}): mae ${row.mae}, ssim ${row.ssim}`)
  for (const row of playing) if (row.playingVsPaused.mae > maxMae || row.playingVsPaused.ssim < minSsim) failures.push(`playing vs paused frame ${row.frame}: ${JSON.stringify(row.playingVsPaused)}`)
  if (playingSamples.length < 20) failures.push(`only ${playingSamples.length} distinct frames were drawn during 3.5 s of playback`)
  if (audioE2e && !(audio?.some((a) => a.currentTime > 0.5) && audio.every((a) => !a.error))) failures.push(`audio did not play: ${JSON.stringify(audio)}`)
  if (!hit.bottomCorner.includes('Bottom') || !hit.topLayer.includes('Top')) failures.push(`canvas click did not select the layer under the pointer: ${JSON.stringify(hit)}`)
  if (cdp.errors.length) failures.push(`JS errors: ${cdp.errors.join(' | ')}`)

  const report = {
    thresholds: { maxMae, minSsim },
    canvas: await cdp.eval(`({ ...window.__state(), dpr: window.devicePixelRatio, innerWidth: window.innerWidth })`),
    paused,
    pausedSummary: { maxMae: Math.max(...paused.map((row) => row.mae)), minSsim: Math.min(...paused.map((row) => row.ssim)) },
    playing,
    playingFramesDrawn: playingSamples.length,
    audio,
    overlayProbe,
    hit,
    jsErrors: cdp.errors,
    failures
  }
  console.log(JSON.stringify(report, null, 2))
  cdp.close()
  if (failures.length) process.exitCode = 1
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await sleep(1000)
  }
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => undefined)
}
