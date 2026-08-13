import { defaultProcessExecutor, type ProcessExecutor } from './ffmpeg/process.js'

export const FALLBACK_FONT_FAMILIES = ['Noto Sans JP', 'Yu Gothic UI', 'Meiryo', 'Arial', 'sans-serif'] as const

const parseRegistryFonts = (text: string): string[] => text.split(/\r?\n/u)
  .map((line) => line.match(/^\s{2,}(.+?)\s+REG_SZ\s+/u)?.[1]?.replace(/\s+\((?:TrueType|OpenType)\)$/iu, '').trim())
  .filter((value): value is string => Boolean(value))

export const enumerateFontFamilies = async (
  executor: ProcessExecutor = defaultProcessExecutor,
  platform = process.platform
): Promise<string[]> => {
  if (platform !== 'win32') return [...FALLBACK_FONT_FAMILIES]
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  ]
  const outputs = await Promise.all(keys.map(async (key) => {
    try {
      return (await executor.run({ command: 'reg.exe', args: ['query', key] })).stdout
    } catch {
      return ''
    }
  }))
  return [...new Set([...FALLBACK_FONT_FAMILIES, ...outputs.flatMap(parseRegistryFonts)])].sort((left, right) => left.localeCompare(right))
}
