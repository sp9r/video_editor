import path from 'node:path'
import { createFfmpegService } from '../ffmpeg/service.js'
import { createPreviewPlan } from '../ffmpeg/render-plan.js'
import { loadEditProject } from './edit-project.js'

const usage = (): string => `
video-editor validate <edit_project.json> [--no-hash]
video-editor probe <edit_project.json> [--no-hash]
video-editor plan <edit_project.json> [--no-hash]
video-editor preview <edit_project.json> [-o preview.mp4] [--no-hash]
video-editor render <edit_project.json> -o output.mp4 [--no-hash]
`

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const projectArgument = (args: string[]): string => {
  const projectPath = args.find((value) => !value.startsWith('-'))
  if (!projectPath) throw new Error(`edit_project path is required.${usage()}`)
  return path.resolve(projectPath)
}

const outputArgument = (args: string[]): string => {
  const output = option(args, '-o')
  if (!output) throw new Error(`-o output.mp4 is required.${usage()}`)
  return path.resolve(output)
}

const baseSettings = (project: Awaited<ReturnType<typeof loadEditProject>>, outputPath: string, software = false) => ({
  outputPath,
  width: Math.max(16, Math.floor(project.document.sequence.width / (software ? 2 : 1) / 2) * 2),
  height: Math.max(16, Math.floor(project.document.sequence.height / (software ? 2 : 1) / 2) * 2),
  frameRate: { numerator: Math.round(project.document.sequence.fps), denominator: 1 },
  videoBitrate: software ? 2_000_000 : 8_000_000,
  audioBitrate: software ? 128_000 : 192_000,
  encoderMode: software ? 'software' as const : 'auto' as const,
  burnSubtitles: true,
  exportSrt: false
})

const summary = (project: Awaited<ReturnType<typeof loadEditProject>>, plan: ReturnType<typeof createPreviewPlan>) => ({
  schema_version: project.document.schema_version,
  project: project.document.project,
  project_path: project.projectPath,
  source_media: [...project.resolvedSourceMedia.entries()].map(([id, resolvedPath]) => ({ id, path: resolvedPath })),
  render_plan: plan
})

const run = async (argv: string[]): Promise<void> => {
  const command = argv[0]
  const args = argv.slice(1)
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return
  }
  const loaded = await loadEditProject(projectArgument(args), { verifyHashes: !args.includes('--no-hash') })
  if (command === 'validate') {
    console.log(JSON.stringify({ valid: true, ...summary(loaded, createPreviewPlan(loaded.project, baseSettings(loaded, 'validate.mp4')) ) }, null, 2))
    return
  }
  const service = await createFfmpegService()
  if (command === 'probe') {
    const media = []
    for (const resolvedPath of loaded.resolvedSourceMedia.values()) media.push(await service.probeMedia(resolvedPath))
    console.log(JSON.stringify({ project_path: loaded.projectPath, media }, null, 2))
    return
  }
  if (command === 'plan') {
    const plan = service.createRenderPlan(loaded.project, baseSettings(loaded, 'plan.mp4'))
    console.log(JSON.stringify({ ...summary(loaded, createPreviewPlan(loaded.project, baseSettings(loaded, 'preview.mp4'))), filter_graph: plan.filterGraph }, null, 2))
    return
  }
  if (command === 'preview' || command === 'render') {
    const outputPath = command === 'preview'
      ? option(args, '-o') ? outputArgument(args) : undefined
      : outputArgument(args)
    if (!outputPath) {
      console.log(JSON.stringify(summary(loaded, createPreviewPlan(loaded.project, baseSettings(loaded, 'preview.mp4', true))), null, 2))
      return
    }
    const job = await service.startExport(loaded.project, baseSettings(loaded, outputPath, command === 'preview'), {
      onProgress: (progress) => console.error(JSON.stringify(progress))
    })
    const result = await job.result
    console.log(JSON.stringify(result, null, 2))
    return
  }
  throw new Error(`Unknown command: ${command}.${usage()}`)
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const result = error instanceof Error ? { error: error.message, ...(error.name === 'EditProjectError' ? { code: (error as { code?: string }).code } : {}) } : { error: String(error) }
  console.error(JSON.stringify(result, null, 2))
  process.exitCode = 1
})

