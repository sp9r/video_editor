import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary for this platform.')

const outputDirectory = path.resolve('fixtures', 'generated')
mkdirSync(outputDirectory, { recursive: true })

const run = (args) => {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
    shell: false
  })
  if (result.status !== 0) throw new Error(`FFmpeg fixture command failed with exit code ${result.status}`)
}

run([
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
  '-c:a', 'aac', '-b:a', '160k', '-shortest',
  path.join(outputDirectory, 'sample-video.mp4')
])

run([
  '-f', 'lavfi', '-i', 'color=c=0x43D6B1@0.85:s=320x180:d=1',
  '-frames:v', '1',
  path.join(outputDirectory, 'sample-overlay.png')
])

run([
  '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4',
  '-c:a', 'pcm_s16le',
  path.join(outputDirectory, 'sample-music.wav')
])

console.log(`Created test media in ${outputDirectory}`)

