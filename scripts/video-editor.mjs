#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await import(pathToFileURL(path.join(root, 'out', 'cli', 'video-editor.js')).href)
