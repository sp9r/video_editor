import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface FfmpegPaths {
  ffmpegPath: string
  ffprobePath: string
}

export interface ResolveFfmpegPathsOptions {
  ffmpegPath?: string | null
  ffprobePath?: string | null
  env?: NodeJS.ProcessEnv
  accessFile?: (path: string) => Promise<void>
}

const unpackAsarPath = (value: string): string => value.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')

const packageFfmpegPath = (): string | null => {
  const loaded = require('ffmpeg-static') as string | null
  return loaded ? unpackAsarPath(loaded) : null
}

const packageFfprobePath = (): string | null => {
  const loaded = require('ffprobe-static') as { path?: string }
  return loaded.path ? unpackAsarPath(loaded.path) : null
}

const assertExecutable = async (
  path: string | null | undefined,
  label: string,
  accessFile: (path: string) => Promise<void>
): Promise<string> => {
  if (!path) throw new Error(`${label} binary is not available for this platform`)
  try {
    await accessFile(path)
    return path
  } catch (error) {
    throw new Error(`${label} binary is not accessible: ${path}`, { cause: error })
  }
}

export const resolveFfmpegPaths = async (options: ResolveFfmpegPathsOptions = {}): Promise<FfmpegPaths> => {
  const env = options.env ?? process.env
  const accessFile = options.accessFile ?? (async (path: string) => await access(path, constants.R_OK | constants.X_OK))
  const ffmpegPath = options.ffmpegPath ?? env.FFMPEG_PATH ?? env.FFMPEG_BIN ?? packageFfmpegPath()
  const ffprobePath = options.ffprobePath ?? env.FFPROBE_PATH ?? packageFfprobePath()
  return {
    ffmpegPath: await assertExecutable(ffmpegPath, 'FFmpeg', accessFile),
    ffprobePath: await assertExecutable(ffprobePath, 'ffprobe', accessFile)
  }
}

export const toUnpackedAsarPath = unpackAsarPath
