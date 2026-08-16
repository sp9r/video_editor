import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const workspace = await mkdtemp(path.join(tmpdir(), 'spectra-night07-'))
const fixturePath = path.join(workspace, 'interaction-project.json')
const now = '2026-08-16T00:00:00.000Z'
const style = {
  fontFamily: 'Noto Sans JP', fontSize: 54, color: '#ffffff', outlineColor: '#111318', outlineWidth: 3,
  shadowColor: '#000000', shadowBlur: 4, backgroundColor: '#000000', backgroundOpacity: 0,
  bold: true, italic: false, letterSpacing: 0, lineHeight: 1.15, alignment: 'bottom', positionX: 50,
  positionY: 86, maxWidthPercent: 80, animation: 'none', animationDurationUs: 0
}
const project = {
  schemaVersion: 1, appVersion: '0.1.0', id: 'night07-project', name: 'NIGHT 07 interaction smoke', createdAt: now, updatedAt: now,
  sequence: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#000000' },
  media: [{ id: 'night07-source', name: 'QA source.mp4', path: 'demo://night07-source.mp4', kind: 'video', durationUs: 6000000, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true, fileSize: 1234, modifiedAt: now, offline: false }],
  tracks: [
    { id: 'night07-video-track', name: 'V1', kind: 'media', clips: [{ id: 'night07-video', name: 'QA source.mp4', kind: 'video', startUs: 0, durationUs: 6000000, sourceInUs: 0, enabled: true, assetId: 'night07-source', transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } }, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 }, sourceAudioEnabled: true }], locked: false, muted: false, hidden: false },
    { id: 'night07-caption-track', name: '自動字幕', kind: 'subtitle', clips: [{ id: 'night07-caption', name: 'caption', kind: 'subtitle', startUs: 500000, durationUs: 1500000, sourceInUs: 500000, enabled: true, text: '字幕テスト', style, sourceCaptionId: 'night07-caption-source', sourceJobId: 'night07-job', words: [{ id: 'night07-word', text: '字幕テスト', startUs: 500000, endUs: 2000000 }], editUnits: [{ id: 'night07-unit', text: '字幕テスト', parentSourceWordId: 'night07-word', startUs: 500000, endUs: 2000000, timingProvenance: 'source' }] }], locked: false, muted: false, hidden: false }
  ]
}

await writeFile(fixturePath, `${JSON.stringify(project)}\n`, 'utf8')
const output = []
const child = spawn(electronPath, ['.'], {
  cwd: repositoryRoot,
  env: { ...process.env, SPECTRA_INTERACTION_SMOKE: '1', SPECTRA_INTERACTION_SMOKE_PROJECT: fixturePath },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => output.push(String(chunk)))
child.stderr.on('data', (chunk) => output.push(String(chunk)))
try {
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron interaction smoke timed out after 30 seconds')) }, 30_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(`Electron interaction smoke exited by ${signal}`)) : resolve(code ?? 1) })
  })
  const reportLine = output.join('').split(/\r?\n/u).find((line) => line.startsWith('SPECTRA_INTERACTION_REPORT '))
  if (!reportLine) throw new Error(`Electron interaction report was not emitted.\n${output.join('')}`)
  const report = JSON.parse(reportLine.slice('SPECTRA_INTERACTION_REPORT '.length))
  if (exitCode !== 0 || report.error) throw new Error(`Electron interaction smoke failed.\n${JSON.stringify(report)}\n${output.join('')}`)
  const states = report.transitions ?? {}
  const assert = (condition, message) => { if (!condition) throw new Error(`${message}: ${JSON.stringify(states)}`) }
  assert(states.clipSelected?.run?.disabled === false, 'selected clip must enable auto processing')
  assert(states.processingRunning?.autoProcessing?.disabled === true, 'processing must disable auto processing')
  assert(String(states.processingRunning?.autoProcessing?.title).includes('実行中'), 'processing must explain why auto processing is disabled')
  assert(states.processingCompleted?.autoProcessing?.disabled === false, 'completed processing must re-enable auto processing')
  assert(states.processingFailed?.autoProcessing?.disabled === false, 'failed processing must leave a retryable action')
  assert(states.noSelectionDialog?.run?.disabled === true && String(states.noSelectionDialog.run.title).includes('対象clip'), 'no selection must explain the prerequisite')
  assert(states.modalClosed?.dialog === false, 'closing the modal must restore the main UI')
  assert(states.subtitleSelected?.fullCorrection?.disabled === false, 'auto-caption subtitle must enable full correction')
  assert(states.reviewMode?.review?.active === true, 'review mode must activate after click')
  assert(states.offlineMedia?.run?.disabled === true && String(states.offlineMedia.run.title).includes('再リンク'), 'offline media must explain disabled auto processing')
  assert(states.noAudio?.run?.disabled === true && String(states.noAudio.run.title).includes('音声'), 'no-audio media must explain disabled auto processing')
  assert(states.multiSelection?.run?.disabled === true && String(states.multiSelection.run.title).includes('1つだけ'), 'multi-selection must explain the single-clip prerequisite')
  console.log(JSON.stringify({ ...report, outputLines: output.length }, null, 2))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
