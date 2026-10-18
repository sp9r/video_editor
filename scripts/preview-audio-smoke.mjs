import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const workspace = await mkdtemp(path.join(tmpdir(), 'spectra-audio-parity-'))
const cases = [
  { name: 'stereo-boost', channels: 2, volumeDb: 24, pan: 0, fadeInUs: 0, fadeOutUs: 0, seek: 0 },
  { name: 'right-pan-fades', channels: 2, volumeDb: 12, pan: 0.25, fadeInUs: 200000, fadeOutUs: 300000, seek: 0 },
  { name: 'left-pan', channels: 2, volumeDb: -6, pan: -1, fadeInUs: 0, fadeOutUs: 0, seek: 0 },
  { name: 'overlap-seek', channels: 2, volumeDb: 6, pan: -0.5, fadeInUs: 800000, fadeOutUs: 800000, seek: 0.35 },
  { name: 'mono-upmix', channels: 1, volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0, seek: 0 },
  { name: 'mono-boost-seek', channels: 1, volumeDb: 12, pan: 0.75, fadeInUs: 400000, fadeOutUs: 700000, seek: 0.5 }
]

const browserRun = async (cases, audioUrl) => {
  const results = []
  for (const item of cases) {
    const length = Math.round(48000 * (1 - item.seek))
    const context = new OfflineAudioContext(2, length, 48000)
    const buffer = context.createBuffer(item.channels, 48000, 48000)
    for (let channel = 0; channel < item.channels; channel++) buffer.getChannelData(channel).fill(0.1 * (channel + 1))
    const source = context.createBufferSource()
    source.buffer = buffer
    // Use the production graph with deterministic PCM, without a sound device.
    context.createMediaElementSource = () => source
    context.close = async () => undefined
    const mixer = new PreviewAudioUnderTest.PreviewAudioMixer(context)
    const audio = document.createElement('audio')
    mixer.update(audio, { ...item, startUs: 1000000, durationUs: 1000000, enabled: true }, 1000000 + item.seek * 1000000, false, item.channels)
    source.start(0, item.seek)
    const rendered = await context.startRendering()
    results.push({ name: item.name, samples: [Array.from(rendered.getChannelData(0)), Array.from(rendered.getChannelData(1))], elementVolume: audio.volume })
    mixer.dispose()
  }
  // Also exercise Chromium's actual MediaElementAudioSourceNode binding and ref reuse.
  const live = new AudioContext()
  const element = document.createElement('audio')
  element.crossOrigin = 'anonymous'
  element.src = audioUrl
  document.body.append(element)
  const mixer = new PreviewAudioUnderTest.PreviewAudioMixer(live)
  const clip = { startUs: 0, durationUs: 1000000, enabled: true, volumeDb: 24, pan: 0.25 }
  mixer.update(element, clip, 0, false)
  const analyser = live.createAnalyser()
  mixer.graphs.get(element).nodes.at(-1).connect(analyser)
  await live.resume()
  await new Promise((resolve, reject) => { element.addEventListener('loadedmetadata', resolve, { once: true }); element.addEventListener('error', reject, { once: true }); element.load() })
  element.currentTime = 0.5
  await element.play()
  const started = performance.now()
  const timer = setInterval(() => {
    const elapsed = (performance.now() - started) / 1000
    mixer.update(element, { ...clip, durationUs: 2000000 }, (0.5 + elapsed) * 1000000, true)
    PreviewAudioUnderTest.syncPreviewMediaTime(element, 0.5 + elapsed)
  }, 16)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  clearInterval(timer)
  const samples = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(samples)
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
  if (rms < 0.01 || live.currentTime < 0.1 || element.currentTime < 0.6) throw new Error('Custom-protocol media playback did not advance: ' + JSON.stringify({ rms, currentTime: element.currentTime, seeking: element.seeking, ready: element.readyState, context: live.state, contextTime: live.currentTime, seekable: Array.from({length: element.seekable.length}, (_, i) => [element.seekable.start(i), element.seekable.end(i)]), buffered: Array.from({length: element.buffered.length}, (_, i) => [element.buffered.start(i), element.buffered.end(i)]) }))
  results.push({ name: 'real-protocol-audio', rms, currentTime: element.currentTime, contextTime: live.currentTime })
  mixer.release(element)
  mixer.update(element, clip, 0, false)
  mixer.dispose()
  return results
}

try {
  const bundle = await build({ entryPoints: [path.join(root, 'src/renderer/src/preview-audio.ts')], bundle: true, write: false, format: 'iife', globalName: 'PreviewAudioUnderTest', platform: 'browser' })
  const bundlePath = path.join(workspace, 'mixer.js')
  const protocolPath = path.join(workspace, 'protocol.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/window.ts')], outfile: protocolPath, bundle: true, format: 'cjs', platform: 'node', packages: 'external', define: { 'import.meta.url': JSON.stringify(new URL('../src/main/window.ts', import.meta.url).href) }, logLevel: 'silent' })
  const audioPath = path.join(workspace, 'real-audio.mp4')
  execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', audioPath], { windowsHide: true, timeout: 15000 })
  const resultPath = path.join(workspace, 'results.json')
  await writeFile(bundlePath, bundle.outputFiles[0].text)
  const mainPath = path.join(workspace, 'main.cjs')
  await writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const protocol = require(${JSON.stringify(protocolPath)});
if (process.env.SPECTRA_AUDIO_PROTOCOL_DEBUG === '1') {
  const { net } = require('electron');
  const original = net.fetch.bind(net);
  net.fetch = async (...args) => { const response = await original(...args); console.error('TRANSPORT', args[0], JSON.stringify([...new Headers(args[1]?.headers).entries()]), response.status, JSON.stringify([...response.headers.entries()])); return response; };
}
protocol.registerPrivilegedSchemes();
app.setPath('userData', ${JSON.stringify(path.join(workspace, 'user-data'))});
app.whenReady().then(async () => {
  protocol.installMediaProtocol();
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadURL('data:text/html,<html><body>Audio parity</body></html>');
  await window.webContents.executeJavaScript(readFileSync(${JSON.stringify(bundlePath)}, 'utf8'));
  const result = await window.webContents.executeJavaScript('(' + ${JSON.stringify(browserRun.toString())} + ')(' + ${JSON.stringify(JSON.stringify(cases))} + ',' + ${JSON.stringify(JSON.stringify(`spectra-media://local/${encodeURIComponent(audioPath)}`))} + ')');
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
`)
  const child = spawn(require('electron'), [mainPath], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Audio smoke timed out: ${output}`)) }, 30000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Audio smoke failed (${code}): ${output}`)) })
  })
  const results = JSON.parse(await readFile(resultPath, 'utf8'))
  const reports = []
  for (const item of cases) {
    const inputPath = path.join(workspace, `${item.name}.raw`)
    const outputPath = path.join(workspace, `${item.name}-final.raw`)
    const input = Buffer.alloc(48000 * item.channels * 4)
    for (let frame = 0; frame < 48000; frame++) for (let channel = 0; channel < item.channels; channel++) input.writeFloatLE(0.1 * (channel + 1), (frame * item.channels + channel) * 4)
    await writeFile(inputPath, input)
    const volume = 10 ** (item.volumeDb / 20)
    const filters = ['aformat=sample_fmts=fltp:channel_layouts=stereo', `volume=${volume.toFixed(6)}`, `pan=stereo|c0=${item.pan <= 0 ? 1 : 1 - item.pan}*c0|c1=${item.pan >= 0 ? 1 : 1 + item.pan}*c1`]
    if (item.fadeInUs) filters.push(`afade=t=in:st=0:d=${item.fadeInUs / 1000000}`)
    if (item.fadeOutUs) filters.push(`afade=t=out:st=${1 - item.fadeOutUs / 1000000}:d=${item.fadeOutUs / 1000000}`)
    execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', String(item.channels), '-i', inputPath, '-af', filters.join(','), '-f', 'f32le', '-c:a', 'pcm_f32le', outputPath], { windowsHide: true, timeout: 15000 })
    const expected = await readFile(outputPath)
    const actual = results.find((result) => result.name === item.name)
    assert.equal(actual.elementVolume, 1)
    const offset = Math.round(item.seek * 48000)
    assert.equal(actual.samples[0].length, 48000 - offset)
    let maxError = 0
    for (let frame = 0; frame < actual.samples[0].length; frame++) for (let channel = 0; channel < 2; channel++) maxError = Math.max(maxError, Math.abs(actual.samples[channel][frame] - expected.readFloatLE(((frame + offset) * 2 + channel) * 4)))
    assert.ok(maxError < 0.0001, `${item.name}: Preview/Final sample error ${maxError}`)
    reports.push({ name: item.name, frames: actual.samples[0].length, maxSampleError: maxError })
  }
  console.log(JSON.stringify({ pass: true, realMediaElementBinding: true, customProtocolRms: results.find((result) => result.name === 'real-protocol-audio').rms, cases: reports }, null, 2))
} finally {
  // workspace is the exact private mkdtemp directory created by this run.
  assert.equal(path.dirname(workspace), tmpdir())
  assert.ok(path.basename(workspace).startsWith('spectra-audio-parity-'))
  await rm(workspace, { recursive: true, force: true })
}
