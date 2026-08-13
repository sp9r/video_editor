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
