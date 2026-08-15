import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  SUBTITLE_TEMPLATES,
  LEGACY_SUBTITLE_TEMPLATE_VERSION,
  SUBTITLE_TEMPLATE_STORE_VERSION,
  SUBTITLE_TEMPLATE_VERSION,
  type SubtitleTemplateCaptionGeneration,
  type SubtitleTemplateDraft,
  type SubtitleTemplateLoadResult,
  type UserSubtitleTemplate
} from '../shared/subtitle-templates.js'
import type { SubtitleTemplateId } from '../shared/auto-caption-contract.js'
import type { SubtitleStyle } from '../shared/types.js'
import type { SegmentationMode } from '../shared/auto-caption-contract.js'

const STORE_FILE = 'subtitle-templates.v1.json'
const MAX_TEMPLATES = 256
const MAX_NAME_LENGTH = 100
const DEFAULT_TEMPLATE_ID: SubtitleTemplateId = 'default'
const STYLE_KEYS = [
  'fontFamily', 'fontSize', 'color', 'outlineColor', 'outlineWidth', 'shadowColor', 'shadowBlur',
  'backgroundColor', 'backgroundOpacity', 'bold', 'italic', 'letterSpacing', 'lineHeight',
  'alignment', 'positionX', 'positionY', 'maxWidthPercent', 'animation', 'animationDurationUs'
] as const
const CAPTION_GENERATION_KEYS = ['maxChars', 'maxLines', 'segmentationMode', 'layoutConstraints'] as const
const LAYOUT_CONSTRAINT_KEYS = ['maxWidthPercent'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown, label: string, minimum?: number, maximum?: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

const text = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`${label} is invalid`)
  return value
}

const assertExactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${label} has unsupported fields`)
}

const parseStyle = (value: unknown, label = 'style'): SubtitleStyle => {
  if (!isRecord(value)) throw new Error(`${label} is invalid`)
  assertExactKeys(value, STYLE_KEYS, label)
  const alignment = text(value.alignment, `${label}.alignment`, 16)
  if (!['top', 'middle', 'bottom'].includes(alignment)) throw new Error(`${label}.alignment is invalid`)
  const animation = text(value.animation, `${label}.animation`, 32)
  if (!['none', 'fade', 'pop', 'slide-up', 'typewriter'].includes(animation)) throw new Error(`${label}.animation is invalid`)
  return {
    fontFamily: text(value.fontFamily, `${label}.fontFamily`, 256),
    fontSize: finite(value.fontSize, `${label}.fontSize`, 1, 10_000),
    color: text(value.color, `${label}.color`, 32),
    outlineColor: text(value.outlineColor, `${label}.outlineColor`, 32),
    outlineWidth: finite(value.outlineWidth, `${label}.outlineWidth`, 0, 1_000),
    shadowColor: text(value.shadowColor, `${label}.shadowColor`, 32),
    shadowBlur: finite(value.shadowBlur, `${label}.shadowBlur`, 0, 1_000),
    backgroundColor: text(value.backgroundColor, `${label}.backgroundColor`, 32),
    backgroundOpacity: finite(value.backgroundOpacity, `${label}.backgroundOpacity`, 0, 1),
    bold: typeof value.bold === 'boolean' ? value.bold : (() => { throw new Error(`${label}.bold is invalid`) })(),
    italic: typeof value.italic === 'boolean' ? value.italic : (() => { throw new Error(`${label}.italic is invalid`) })(),
    letterSpacing: finite(value.letterSpacing, `${label}.letterSpacing`, -1_000, 1_000),
    lineHeight: finite(value.lineHeight, `${label}.lineHeight`, 0.1, 10),
    alignment: alignment as SubtitleStyle['alignment'],
    positionX: finite(value.positionX, `${label}.positionX`),
    positionY: finite(value.positionY, `${label}.positionY`),
    maxWidthPercent: finite(value.maxWidthPercent, `${label}.maxWidthPercent`, 0.1, 1_000),
    animation: animation as SubtitleStyle['animation'],
    animationDurationUs: finite(value.animationDurationUs, `${label}.animationDurationUs`, 0, Number.MAX_SAFE_INTEGER)
  }
}

const parseCaptionGeneration = (value: unknown, style: SubtitleStyle, label = 'captionGeneration'): SubtitleTemplateCaptionGeneration => {
  if (!isRecord(value)) throw new Error(`${label} is invalid`)
  assertExactKeys(value, CAPTION_GENERATION_KEYS, label)
  if (!Number.isSafeInteger(value.maxChars) || !Number.isSafeInteger(value.maxLines)) throw new Error(`${label} counts must be integers`)
  const segmentationMode = text(value.segmentationMode, `${label}.segmentationMode`, 16)
  if (!['auto', 'rule', 'llm'].includes(segmentationMode)) throw new Error(`${label}.segmentationMode is invalid`)
  if (!isRecord(value.layoutConstraints)) throw new Error(`${label}.layoutConstraints is invalid`)
  assertExactKeys(value.layoutConstraints, LAYOUT_CONSTRAINT_KEYS, `${label}.layoutConstraints`)
  const maxWidthPercent = finite(value.layoutConstraints.maxWidthPercent, `${label}.layoutConstraints.maxWidthPercent`, 0.1, 1_000)
  if (maxWidthPercent !== style.maxWidthPercent) throw new Error(`${label}.layoutConstraints.maxWidthPercent must match style.maxWidthPercent`)
  return {
    maxChars: finite(value.maxChars, `${label}.maxChars`, 1, 10_000),
    maxLines: finite(value.maxLines, `${label}.maxLines`, 1, 16),
    segmentationMode: segmentationMode as SegmentationMode,
    layoutConstraints: { maxWidthPercent }
  }
}

const parseDraft = (value: unknown): SubtitleTemplateDraft => {
  if (!isRecord(value)) throw new Error('subtitle template is invalid')
  assertExactKeys(value, ['name', 'style', 'captionGeneration'], 'subtitle template')
  const name = text(value.name, 'subtitle template.name', MAX_NAME_LENGTH)
  if (/[A-Za-z]:[\\/]|^[/\\]{1,2}/.test(name)) throw new Error('subtitle template.name must not be a path')
  const style = parseStyle(value.style)
  return {
    name,
    style,
    captionGeneration: parseCaptionGeneration(value.captionGeneration, style)
  }
}

const parseTemplate = (value: unknown): UserSubtitleTemplate => {
  if (!isRecord(value)) throw new Error('subtitle template is invalid')
  const version = value.version
  if (version === LEGACY_SUBTITLE_TEMPLATE_VERSION) {
    assertExactKeys(value, ['version', 'id', 'name', 'style', 'maxChars', 'maxLines', 'createdAt', 'updatedAt'], 'legacy subtitle template')
  } else if (version === SUBTITLE_TEMPLATE_VERSION) {
    assertExactKeys(value, ['version', 'id', 'name', 'style', 'captionGeneration', 'createdAt', 'updatedAt'], 'subtitle template')
  } else {
    throw new Error('unsupported subtitle template version')
  }
  const id = text(value.id, 'subtitle template.id', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('subtitle template.id is invalid')
  const createdAt = text(value.createdAt, 'subtitle template.createdAt', 64)
  const updatedAt = text(value.updatedAt, 'subtitle template.updatedAt', 64)
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('subtitle template date is invalid')
  const style = parseStyle(value.style)
  const captionGeneration = version === LEGACY_SUBTITLE_TEMPLATE_VERSION
    ? parseCaptionGeneration({ maxChars: value.maxChars, maxLines: value.maxLines, segmentationMode: 'auto', layoutConstraints: { maxWidthPercent: style.maxWidthPercent } }, style, 'legacy captionGeneration')
    : parseCaptionGeneration(value.captionGeneration, style)
  const draft = parseDraft({ name: value.name, style, captionGeneration })
  return { version: SUBTITLE_TEMPLATE_VERSION, id, ...draft, createdAt, updatedAt }
}

const storePath = (userDataPath: string): string => path.join(userDataPath, STORE_FILE)

const renameAtomicallyWithWindowsRetry = async (temporary: string, target: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target)
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if (!['EPERM', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

const validTemplateId = (value: unknown): value is SubtitleTemplateId =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

const isBuiltInTemplateId = (id: SubtitleTemplateId): boolean => SUBTITLE_TEMPLATES.some((template) => template.id === id)

const readStore = async (userDataPath: string): Promise<SubtitleTemplateLoadResult> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(userDataPath), 'utf8'))
    if (!isRecord(parsed) || parsed.version !== SUBTITLE_TEMPLATE_STORE_VERSION || !Array.isArray(parsed.templates) || parsed.templates.length > MAX_TEMPLATES) throw new Error('malformed store')
    const templates: UserSubtitleTemplate[] = []
    let migratedCount = 0
    for (const item of parsed.templates) {
      try {
        const parsedTemplate = parseTemplate(item)
        if (isRecord(item) && item.version === LEGACY_SUBTITLE_TEMPLATE_VERSION) migratedCount += 1
        templates.push(parsedTemplate)
      } catch { /* ignore one malformed template */ }
    }
    const unique = templates.filter((template, index) => templates.findIndex((candidate) => candidate.id === template.id) === index)
    let defaultTemplateId = DEFAULT_TEMPLATE_ID
    let malformedCount = parsed.templates.length - templates.length + templates.length - unique.length
    if (parsed.defaultTemplateId !== undefined) {
      if (!validTemplateId(parsed.defaultTemplateId)) malformedCount += 1
      else if (isBuiltInTemplateId(parsed.defaultTemplateId) || unique.some((template) => template.id === parsed.defaultTemplateId)) defaultTemplateId = parsed.defaultTemplateId
      else malformedCount += 1
    }
    return { userTemplates: unique, malformedCount, migratedCount, defaultTemplateId }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { userTemplates: [], malformedCount: 0, migratedCount: 0, defaultTemplateId: DEFAULT_TEMPLATE_ID }
    return { userTemplates: [], malformedCount: 1, migratedCount: 0, defaultTemplateId: DEFAULT_TEMPLATE_ID }
  }
}

const writeStore = async (userDataPath: string, templates: readonly UserSubtitleTemplate[], defaultTemplateId: SubtitleTemplateId): Promise<void> => {
  const directory = path.dirname(storePath(userDataPath))
  await mkdir(directory, { recursive: true })
  const target = storePath(userDataPath)
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify({ version: SUBTITLE_TEMPLATE_STORE_VERSION, defaultTemplateId, templates }, null, 2)}\n`, 'utf8')
    await renameAtomicallyWithWindowsRetry(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

const newTemplate = (draft: SubtitleTemplateDraft): UserSubtitleTemplate => {
  const now = new Date().toISOString()
  return { version: SUBTITLE_TEMPLATE_VERSION, id: `user-template-${randomUUID()}`, ...draft, createdAt: now, updatedAt: now }
}

export class SubtitleTemplateService {
  constructor(private readonly userDataPath: string) {}

  async load(): Promise<SubtitleTemplateLoadResult> {
    const current = await readStore(this.userDataPath)
    if (current.migratedCount > 0) await writeStore(this.userDataPath, current.userTemplates, current.defaultTemplateId)
    return current
  }

  async create(input: unknown): Promise<UserSubtitleTemplate> {
    const draft = parseDraft(input)
    const current = await readStore(this.userDataPath)
    const created = newTemplate(draft)
    await writeStore(this.userDataPath, [...current.userTemplates, created], current.defaultTemplateId)
    return created
  }

  async update(idInput: unknown, input: unknown): Promise<UserSubtitleTemplate> {
    const id = text(idInput, 'subtitle template.id', 128)
    const draft = parseDraft(input)
    const current = await readStore(this.userDataPath)
    const existing = current.userTemplates.find((template) => template.id === id)
    if (!existing) throw new Error('subtitle template not found')
    const updated = { ...existing, ...draft, updatedAt: new Date().toISOString() }
    await writeStore(this.userDataPath, current.userTemplates.map((template) => template.id === id ? updated : template), current.defaultTemplateId)
    return updated
  }

  async duplicate(input: unknown): Promise<UserSubtitleTemplate> {
    const draft = parseDraft(input)
    const current = await readStore(this.userDataPath)
    const created = newTemplate({ ...draft, name: `${draft.name} copy`.slice(0, MAX_NAME_LENGTH) })
    await writeStore(this.userDataPath, [...current.userTemplates, created], current.defaultTemplateId)
    return created
  }

  async remove(idInput: unknown): Promise<boolean> {
    const id = text(idInput, 'subtitle template.id', 128)
    const current = await readStore(this.userDataPath)
    const next = current.userTemplates.filter((template) => template.id !== id)
    if (next.length === current.userTemplates.length) return false
    await writeStore(this.userDataPath, next, current.defaultTemplateId === id ? DEFAULT_TEMPLATE_ID : current.defaultTemplateId)
    return true
  }

  async setDefault(idInput: unknown): Promise<SubtitleTemplateLoadResult> {
    const id = text(idInput, 'subtitle template.id', 128)
    const current = await readStore(this.userDataPath)
    if (!validTemplateId(id) || (!isBuiltInTemplateId(id) && !current.userTemplates.some((template) => template.id === id))) {
      throw new Error('subtitle template not found')
    }
    await writeStore(this.userDataPath, current.userTemplates, id)
    return { ...current, defaultTemplateId: id }
  }
}
