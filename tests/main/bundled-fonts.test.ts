import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledFontsDirectory, fontsDirForWorkingDirectory, resetBundledFontsDirectory } from '../../src/main/ffmpeg/fonts'
import { assFilter } from '../../src/main/ffmpeg/render-plan'

describe('fonts bundled with Cutline', () => {
  afterEach(() => {
    delete process.env.SPECTRA_BUNDLED_FONTS_DIR
    resetBundledFontsDirectory()
  })

  it('finds resources/fonts with けいふぉんと from the source tree', () => {
    resetBundledFontsDirectory()
    expect(bundledFontsDirectory()).toBe(resolve(__dirname, '..', '..', 'resources', 'fonts'))
  })

  it('gives FFmpeg a relative fontsdir without a drive letter', async () => {
    resetBundledFontsDirectory()
    const work = await mkdtemp(join(tmpdir(), 'cutline-fonts-'))
    try {
      const fontsDir = await fontsDirForWorkingDirectory(work)
      expect(fontsDir).toBeTruthy()
      expect(fontsDir).not.toMatch(/[:\\']/u)
      expect(resolve(work, fontsDir!)).toBe(bundledFontsDirectory())
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  it('copies the fonts beside the job when the bundled path cannot be written relatively', async () => {
    const work = await mkdtemp(join(tmpdir(), "cutline-fonts-'quote-"))
    process.env.SPECTRA_BUNDLED_FONTS_DIR = resolve(__dirname, '..', '..', 'resources', 'fonts')
    resetBundledFontsDirectory()
    try {
      // A quote in the relative path is not safe inside fontsdir='…'.
      const nested = join(work, "it's")
      const { mkdir } = await import('node:fs/promises')
      await mkdir(nested, { recursive: true })
      const fontsDir = await fontsDirForWorkingDirectory(nested)
      expect(fontsDir === 'fonts' || !fontsDir!.includes("'")).toBe(true)
      if (fontsDir === 'fonts') expect((await stat(join(nested, 'fonts', 'keifont.ttf'))).size).toBeGreaterThan(1_000_000)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  it('adds fontsdir to the libass filter only when given', () => {
    expect(assFilter('a.ass')).toBe("ass=filename='a.ass'")
    expect(assFilter('a.ass', '../fonts')).toBe("ass=filename='a.ass':fontsdir='../fonts'")
  })
})
