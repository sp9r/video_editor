import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import react from '@vitejs/plugin-react'
import { build as viteBuild } from 'vite'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.join(repositoryRoot, 'out')

await rm(outputRoot, { recursive: true, force: true })

await Promise.all([
  esbuild({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(repositoryRoot, 'src', 'main', 'index.ts')],
    outfile: path.join(outputRoot, 'main', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    logLevel: 'info'
  }),
  esbuild({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(repositoryRoot, 'src', 'main', 'standalone', 'cli.ts')],
    outfile: path.join(outputRoot, 'cli', 'video-editor.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    logLevel: 'info'
  }),
  esbuild({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(repositoryRoot, 'src', 'preload', 'index.ts')],
    outfile: path.join(outputRoot, 'preload', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    logLevel: 'info'
  }),
  viteBuild({
    configFile: false,
    root: path.join(repositoryRoot, 'src', 'renderer'),
    plugins: [react()],
    build: {
      outDir: path.join(outputRoot, 'renderer'),
      emptyOutDir: false,
      sourcemap: false
    },
    logLevel: 'info'
  })
])
