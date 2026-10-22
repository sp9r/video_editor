import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fonts shipped with Cutline (resources/fonts, outside app.asar when packaged).
 * libass reads them through the ass filter's fontsdir, so subtitles look the same
 * in Accurate Preview, the subtitle overlays and Final on PCs without the font.
 */
export const BUNDLED_FONT_FILES = ['keifont.ttf'] as const

const moduleDirectory = (): string | undefined => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
}

const candidateDirectories = (): string[] => {
  const here = moduleDirectory()
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    ...(process.env.SPECTRA_BUNDLED_FONTS_DIR ? [process.env.SPECTRA_BUNDLED_FONTS_DIR] : []),
    ...(resourcesPath ? [join(resourcesPath, 'fonts')] : []),
    // out/main/index.js and out/cli/video-editor.js
    ...(here ? [join(here, '..', '..', 'resources', 'fonts')] : []),
    // src/main/ffmpeg/fonts.ts (tests run from source)
    ...(here ? [join(here, '..', '..', '..', 'resources', 'fonts')] : []),
    join(process.cwd(), 'resources', 'fonts')
  ]
}

let cachedDirectory: string | null | undefined

export const bundledFontsDirectory = (): string | undefined => {
  if (cachedDirectory === undefined) {
    cachedDirectory = candidateDirectories().find((directory) => BUNDLED_FONT_FILES.every((file) => existsSync(join(directory, file)))) ?? null
  }
  return cachedDirectory ?? undefined
}

/** Test hook: forget the resolved directory so a changed environment is picked up. */
export const resetBundledFontsDirectory = (): void => {
  cachedDirectory = undefined
}

// The value sits inside '…' in a filter graph; ':' would need escaping, so a drive letter is never used.
const SAFE_FONTSDIR = /^[^':\\\n\r;,[\]]+$/u

/**
 * The fontsdir value for an FFmpeg run in `cwd`: the bundled directory relative to
 * cwd, or a copy beside the job when no plain relative path exists (another drive).
 */
export const fontsDirForWorkingDirectory = async (cwd: string): Promise<string | undefined> => {
  const directory = bundledFontsDirectory()
  if (!directory) return undefined
  const relativePath = relative(cwd, directory).replace(/\\/gu, '/')
  if (relativePath && !isAbsolute(relativePath) && SAFE_FONTSDIR.test(relativePath)) return relativePath
  const local = join(cwd, 'fonts')
  await mkdir(local, { recursive: true })
  for (const file of BUNDLED_FONT_FILES) {
    const target = join(local, file)
    const existing = await stat(target).catch(() => null)
    if (!existing?.isFile()) await copyFile(join(directory, file), target)
  }
  return 'fonts'
}
