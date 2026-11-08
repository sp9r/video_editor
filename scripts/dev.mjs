import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { context as esbuildContext } from 'esbuild'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')

const common = {
  absWorkingDir: repositoryRoot,
  bundle: true,
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info'
}

const [mainContext, preloadContext] = await Promise.all([
  esbuildContext({
    ...common,
    entryPoints: [path.join(repositoryRoot, 'src', 'main', 'index.ts')],
    outfile: path.join(repositoryRoot, 'out', 'main', 'index.js'),
    format: 'esm'
  }),
  esbuildContext({
    ...common,
    entryPoints: [path.join(repositoryRoot, 'src', 'preload', 'index.ts')],
    outfile: path.join(repositoryRoot, 'out', 'preload', 'index.js'),
    format: 'cjs'
  })
])

await Promise.all([mainContext.watch(), preloadContext.watch()])

const server = await createServer({
  configFile: false,
  root: path.join(repositoryRoot, 'src', 'renderer'),
  plugins: [react()],
  server: { host: '127.0.0.1' },
  clearScreen: false
})
await server.listen()
server.printUrls()

const rendererUrl = server.resolvedUrls?.local[0]
if (!rendererUrl) throw new Error('Vite development URL could not be resolved.')

const electron = spawn(electronPath, ['.'], {
  cwd: repositoryRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  stdio: 'inherit',
  windowsHide: false,
  shell: false
})

const shutdown = async () => {
  if (!electron.killed) electron.kill()
  await Promise.all([server.close(), mainContext.dispose(), preloadContext.dispose()])
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
electron.once('exit', (code) => void shutdown().finally(() => process.exit(code ?? 0)))
