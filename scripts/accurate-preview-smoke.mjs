import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const ffmpegPath = require('ffmpeg-static')
const rendererIndex = path.join(repositoryRoot, 'out', 'renderer', 'index.html')
if (!existsSync(rendererIndex)) throw new Error(`Renderer build is missing: ${rendererIndex}`)

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
    sequence: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#102030' },
    media: [{ id: 'source', name: 'source.png', path: sourcePath, kind: 'image', durationUs: 0, width: 320, height: 180, hasAudio: false, fileSize: 0, modifiedAt: '2026-08-14T00:00:00.000Z', offline: false }],
    tracks: [
      { id: 'video', name: 'V1', kind: 'video', locked: false, muted: false, hidden: false, clips: [{ id: 'video-1', name: 'Source', kind: 'image', assetId: 'source', startUs: 0, durationUs: 1000000, sourceInUs: 0, enabled: true, transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } } }] },
      { id: 'subtitle', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false, clips: [{ id: 'caption-1', name: 'Caption', kind: 'subtitle', text: 'Accurate Preview', startUs: 200000, durationUs: 600000, sourceInUs: 0, enabled: true, style: { fontFamily: 'Arial', fontSize: 24, color: '#ffffff', outlineColor: '#111318', outlineWidth: 3, shadowColor: '#000000', shadowBlur: 4, backgroundColor: '#000000', backgroundOpacity: 0.15, bold: true, italic: false, letterSpacing: 0, lineHeight: 1.15, alignment: 'bottom', positionX: 50, positionY: 86, maxWidthPercent: 80, animation: 'none', animationDurationUs: 0 } }] }
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
  if (!report.accurateInitial || !report.editPendingPreservesOverlay || !report.editedFrameReady || !report.fastDuringPlay || !report.overlayImmediatelyAfterPause || !report.accurateAfterResume || report.overlayCount !== 1 || report.initialOverlaySrc === report.editedOverlaySrc || report.consoleErrors?.length || report.loadFailure || report.renderProcessGone) {
    throw new Error(`Accurate Preview DOM gate failed.\n${JSON.stringify(report)}\n${output}`)
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
