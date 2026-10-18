import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(repositoryRoot, 'out', 'renderer')
const indexPath = path.join(rendererRoot, 'index.html')
const require = createRequire(import.meta.url)
const electronPath = process.env.SPECTRA_SMOKE_EXECUTABLE ?? require('electron')
if (!electronPath || !existsSync(electronPath)) throw new Error(`Electron executable is missing: ${electronPath}`)

if (!existsSync(indexPath)) throw new Error(`Renderer build is missing: ${indexPath}`)
const html = readFileSync(indexPath, 'utf8')
if (/\b(?:src|href)=["']\/assets\//u.test(html)) throw new Error('Renderer HTML contains root-absolute /assets reference')
const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gu)]
  .map((match) => match[1])
  .filter((reference) => reference?.startsWith('./'))
for (const reference of references) {
  if (!reference) continue
  const assetPath = path.resolve(rendererRoot, reference)
  if (!existsSync(assetPath)) throw new Error(`Renderer asset is missing: ${assetPath}`)
}

const output = []
const child = spawn(electronPath, process.env.SPECTRA_SMOKE_EXECUTABLE ? [] : ['.'], {
  cwd: repositoryRoot,
  env: { ...process.env, SPECTRA_STARTUP_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  shell: false
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => output.push(String(chunk)))
child.stderr.on('data', (chunk) => output.push(String(chunk)))

const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill()
    reject(new Error('Electron startup smoke timed out after 20 seconds'))
  }, 20_000)
  child.once('error', (error) => { clearTimeout(timer); reject(error) })
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    if (signal) reject(new Error(`Electron startup smoke exited by ${signal}`))
    else resolve(code ?? 1)
  })
})

const reportLine = output.join('').split(/\r?\n/u).find((line) => line.startsWith('SPECTRA_STARTUP_REPORT '))
if (!reportLine) throw new Error(`Electron startup report was not emitted.\n${output.join('')}`)
const report = JSON.parse(reportLine.slice('SPECTRA_STARTUP_REPORT '.length))
if (exitCode !== 0 || report.error) throw new Error(`Electron renderer startup failed.\n${JSON.stringify(report)}\n${output.join('')}`)
if (!report.didFinishLoad || !report.rendererProcessAlive || report.rootChildCount <= 0 || !report.appShellPresent || !report.preloadApiPresent || !report.playheadPresent || report.consoleErrors?.length || report.loadFailure || report.renderProcessGone) {
  throw new Error(`Electron renderer DOM startup gate failed.\n${JSON.stringify(report)}`)
}
console.log(JSON.stringify({
  assetReferences: references,
  assetFilesVerified: references.length,
  ...report
}, null, 2))
