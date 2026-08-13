import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, net, protocol, session } from 'electron'

const MEDIA_SCHEME = 'spectra-media'
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const ALLOWED_MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'
])

export interface RendererStartupReport {
  didFinishLoad: boolean
  rendererProcessAlive: boolean
  rootChildCount: number
  appShellPresent: boolean
  preloadApiPresent: boolean
  consoleErrors: string[]
  loadFailure: string | null
  renderProcessGone: string | null
}

const rendererDiagnostics = new WeakMap<BrowserWindow, { consoleErrors: string[]; loadFailure: string | null; renderProcessGone: string | null }>()

const diagnosticsFor = (window: BrowserWindow): { consoleErrors: string[]; loadFailure: string | null; renderProcessGone: string | null } => {
  const existing = rendererDiagnostics.get(window)
  if (existing) return existing
  const created = { consoleErrors: [], loadFailure: null, renderProcessGone: null }
  rendererDiagnostics.set(window, created)
  return created
}

const installRendererDiagnostics = (window: BrowserWindow): void => {
  const diagnostics = diagnosticsFor(window)
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    diagnostics.loadFailure = `${errorCode}: ${errorDescription} (${validatedURL})`
    console.error(`[renderer] did-fail-load ${diagnostics.loadFailure}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.renderProcessGone = `${details.reason}${details.exitCode === undefined ? '' : ` (${details.exitCode})`}`
    console.error(`[renderer] render-process-gone ${diagnostics.renderProcessGone}`)
  })
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 3) return
    const entry = `${message} (${sourceId}:${line})`
    diagnostics.consoleErrors.push(entry)
    console.error(`[renderer] console-error ${entry}`)
  })
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const waitForRendererStartup = async (window: BrowserWindow, timeoutMs = 15_000): Promise<RendererStartupReport> => {
  const diagnostics = diagnosticsFor(window)
  let didFinishLoad = false
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`renderer did-finish-load timeout after ${timeoutMs}ms`)), timeoutMs)
    const onFinished = (): void => {
      clearTimeout(timer)
      didFinishLoad = true
      resolve()
    }
    const onFailed = (): void => {
      clearTimeout(timer)
      reject(new Error(diagnostics.loadFailure ?? 'renderer failed to load'))
    }
    window.webContents.once('did-finish-load', onFinished)
    window.webContents.once('did-fail-load', onFailed)
  })

  const deadline = Date.now() + timeoutMs
  let dom = { rootChildCount: 0, appShellPresent: false, preloadApiPresent: false }
  while (Date.now() < deadline) {
    dom = await window.webContents.executeJavaScript(`(() => ({
      rootChildCount: document.querySelector('#root')?.childElementCount ?? 0,
      appShellPresent: document.querySelector('.app-shell') !== null,
      preloadApiPresent: typeof window.spectra !== 'undefined'
    }))()`)
    if (dom.rootChildCount > 0 && dom.appShellPresent && dom.preloadApiPresent) break
    await delay(50)
  }
  const report: RendererStartupReport = {
    didFinishLoad,
    rendererProcessAlive: !window.webContents.isDestroyed(),
    ...dom,
    consoleErrors: [...diagnostics.consoleErrors],
    loadFailure: diagnostics.loadFailure,
    renderProcessGone: diagnostics.renderProcessGone
  }
  if (!report.didFinishLoad || !report.rendererProcessAlive || report.rootChildCount === 0 || !report.appShellPresent || !report.preloadApiPresent || report.consoleErrors.length > 0 || report.loadFailure || report.renderProcessGone) {
    throw new Error(`renderer startup gate failed: ${JSON.stringify(report)}`)
  }
  return report
}

export const registerPrivilegedSchemes = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

export const installMediaProtocol = (): void => {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!path.isAbsolute(filePath) || !ALLOWED_MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return new Response('Unsupported media path', { status: 403 })
      }
      const info = await stat(filePath)
      if (!info.isFile()) return new Response('Not a regular file', { status: 404 })
      return net.fetch(pathToFileURL(filePath).toString(), { headers: request.headers })
    } catch {
      return new Response('Media not found', { status: 404 })
    }
  })
}

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: 'Spectra Video Studio',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(moduleDirectory, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false
    }
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  installRendererDiagnostics(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = window.webContents.getURL()
    if (targetUrl !== currentUrl) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void window.loadURL(rendererUrl)
  else void window.loadFile(path.join(moduleDirectory, '../renderer/index.html'))

  return window
}

export const isTrustedIpcUrl = (url: string): boolean => {
  if (url.startsWith('file://')) return true
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  return Boolean(rendererUrl && url.startsWith(rendererUrl))
}
