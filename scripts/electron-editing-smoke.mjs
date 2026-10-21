// Real-Electron editing smoke: drives the actual UI through the Chrome DevTools
// Protocol (real mouse/keyboard events, real ffprobe import, isolated profile).
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const SOURCE_VIDEO = process.env.SPECTRA_EDITING_SMOKE_VIDEO ?? 'C:\\Storage\\30_Software\\90_Self_Made\\QA\\spectra-real-japanese-corpus-20260816\\A_job_interview.webm'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const runEditingSmoke = async ({ repositoryRoot, electronPath, workspace }) => {
  const media = path.join(workspace, 'editing-source.webm')
  await copyFile(SOURCE_VIDEO, media) // never touch the QA folder
  const profile = await mkdtemp(path.join(tmpdir(), 'spectra-editing-profile-'))
  const port = 9300 + Math.floor(Math.random() * 500)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('SPECTRA_')) delete env[key]
  // Smoke mode gives an isolated profile and enables the spectra:e2e-project hook (used for the linked-pair drag checks).
  env.SPECTRA_ACCURATE_PREVIEW_SMOKE = '1'
  const output = []
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { cwd: repositoryRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (c) => output.push(String(c)))
  child.stderr.on('data', (c) => output.push(String(c)))
  const results = []
  let socket
  let nextId = 1
  const pending = new Map()
  try {
    let target
    for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
      await sleep(500)
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl)
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error(`Electron DevTools endpoint did not start.\n${output.join('')}`)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data)
      const waiter = data.id ? pending.get(data.id) : null
      if (waiter) { pending.delete(data.id); data.error ? waiter.reject(new Error(JSON.stringify(data.error))) : waiter.resolve(data.result) }
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
      return result.result.value
    }
    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
    const click = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(120) }
    // modifiers: CDP bitmask (Alt = 1). probe runs just before release, while the drag is still live.
    const drag = async (x0, y0, x1, y1, modifiers = 0, probe = null) => {
      const extra = { modifiers }
      await mouse('mouseMoved', x0, y0, { buttons: 0, ...extra }); await mouse('mousePressed', x0, y0, extra)
      for (let step = 1; step <= 8; step += 1) await mouse('mouseMoved', x0 + ((x1 - x0) * step) / 8, y0 + ((y1 - y0) * step) / 8, extra)
      const probed = probe ? await probe() : undefined
      await mouse('mouseReleased', x1, y1, extra); await sleep(200)
      return probed
    }
    const KEYS = { k: ['KeyK', 75], z: ['KeyZ', 90], y: ['KeyY', 89], c: ['KeyC', 67], v: ['KeyV', 86], a: ['KeyA', 65], s: ['KeyS', 83] }
    const key = async (name, modifiers = 0) => {
      const named = { Delete: ['Delete', 46], Space: ['Space', 32], Escape: ['Escape', 27] }[name]
      const [code, vk] = named ?? KEYS[name]
      const base = { key: named ? (name === 'Space' ? ' ' : name) : (modifiers & 8 ? name.toUpperCase() : name), code, windowsVirtualKeyCode: vk, modifiers }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(150)
    }
    const CTRL = 2
    const SHIFT = 8
    const snapshot = () => evaluate(`(() => {
      const num = (value) => Math.round(value * 10) / 10
      const lanes = [...document.querySelectorAll('.track-lane')].map((lane) => ({ id: lane.dataset.trackId, locked: lane.classList.contains('is-locked'), rect: lane.getBoundingClientRect().toJSON() }))
      const clips = [...document.querySelectorAll('.track-lane .timeline-clip')].map((el) => { const r = el.getBoundingClientRect(); return { track: el.closest('.track-lane').dataset.trackId, label: el.getAttribute('aria-label'), x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), selected: el.classList.contains('is-selected'), left: parseFloat(el.style.left), width: parseFloat(el.style.width) } }).sort((a, b) => a.left - b.left)
      const footer = document.querySelector('.timeline-footer code')?.textContent ?? ''
      const ruler = document.querySelector('.time-ruler')?.getBoundingClientRect().toJSON()
      return { lanes, clips, footer, ruler, toast: document.querySelector('.toast')?.textContent ?? '', inspector: document.querySelector('.inspector')?.textContent?.slice(0, 80) ?? '', undoDisabled: document.querySelector('button[aria-label^="元に戻す"]')?.disabled, banner: document.querySelector('.error-banner')?.textContent ?? '' }
    })()`)
    const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) }); if (!ok) console.error(`FAIL ${name}: ${JSON.stringify(detail)}`) }

    // Wait for the UI.
    for (let attempt = 0; attempt < 60 && !(await evaluate(`Boolean(document.querySelector('.timeline-panel') && document.querySelector('.media-bin') && document.querySelector('.time-ruler'))`)); attempt += 1) await sleep(250)
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await sleep(500)

    // 1. Import by OS-style file drop onto the media bin.
    const bin = await evaluate(`(() => { const r = document.querySelector('.media-bin').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    const dragData = { items: [], files: [media], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: bin.x, y: bin.y, data: dragData })
    let assets = 0
    for (let attempt = 0; attempt < 40 && !assets; attempt += 1) { await sleep(300); assets = await evaluate(`document.querySelectorAll('.media-item').length`) }
    check('import: dropped file appears in media bin (real ffprobe)', assets === 1, { assets })
    // Re-import the same file: must not create a duplicate or orphan clips.
    for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: bin.x, y: bin.y, data: dragData })
    await sleep(1500)
    check('import: dropping the same file again does not duplicate it', (await evaluate(`document.querySelectorAll('.media-item').length`)) === 1)

    // 2. Place on the timeline.
    await evaluate(`document.querySelector('.media-add-to-timeline').click()`)
    await sleep(300)
    let s = await snapshot()
    check('place: add-to-timeline creates one clip', s.clips.length === 1, s.clips)
    const zoom = 72
    const secondsX = (sec) => s.ruler.x + sec * zoom
    check('place: clip starts at 0 and is selected', s.clips[0].left === 0 && s.clips[0].selected, s.clips[0])
    // Shorten the long interview to 8 s through the Inspector so everything stays on screen.
    const setField = async (prefix, text) => {
      await evaluate(`(() => { const f = [...document.querySelectorAll('.inspector .field')].find((x) => x.textContent.startsWith(${JSON.stringify(prefix)})); const i = f.querySelector('input'); i.focus(); i.select() })()`)
      for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch })
      await sleep(150)
      const shown = await evaluate(`document.activeElement.value`)
      await evaluate(`document.activeElement.blur()`)
      await sleep(200)
      return shown
    }
    const shownLength = await setField('長さ', '8.0')
    s = await snapshot()
    check('inspector: typing "8.0" into the length field trims the clip to 8 s', shownLength === '8.0' && Math.abs(s.clips[0].width - 8 * zoom) < 2, { shownLength, width: s.clips[0].width })
    const clip0 = s.clips[0]

    // 3. Playhead scrub + split with Ctrl+K at 2s.
    await click(secondsX(2), s.ruler.y + 10)
    s = await snapshot()
    check('scrub: ruler click moves playhead to ~2s', /^00:00:02:/.test(s.footer), s.footer)
    await click(secondsX(1), clip0.y + clip0.h / 2) // click the clip before the playhead is inside it
    await click(secondsX(2), s.ruler.y + 10)
    await click(secondsX(2.5), clip0.y + clip0.h / 2) // select clip while playhead sits at 2s: playhead must stay
    s = await snapshot()
    check('select: clicking a clip does not pull the playhead out of it', /^00:00:02:/.test(s.footer), s.footer)
    await key('k', CTRL)
    s = await snapshot()
    check('split: Ctrl+K cuts the selected clip at the playhead', s.clips.length === 2 && Math.abs(s.clips[1].left - 2 * zoom) < 1.5, s.clips)
    check('split: no unhandled error banner', !s.banner, s.banner)

    // 4. Undo / redo shortcuts and stale selection.
    await key('z', CTRL)
    s = await snapshot()
    check('undo: Ctrl+Z restores the single clip', s.clips.length === 1, s.clips)
    await key('z', CTRL | SHIFT)
    s = await snapshot()
    check('redo: Ctrl+Shift+Z re-applies the split', s.clips.length === 2, s.clips)
    await key('z', CTRL)
    await key('y', CTRL)
    s = await snapshot()
    check('redo: Ctrl+Y re-applies the split', s.clips.length === 2, s.clips)

    // 5. Nothing selected: Ctrl+K cuts the clip under the playhead (move playhead to 1s first).
    await click(secondsX(9.5), clip0.y + clip0.h / 2) // empty lane area past the clip deselects
    await click(secondsX(1), s.ruler.y + 10)
    await key('k', CTRL)
    s = await snapshot()
    check('split: with no selection Ctrl+K cuts the clip under the playhead', s.clips.length === 3, s.clips)

    // 6. Razor tool on a video clip.
    await key('c')
    await click(secondsX(3), s.clips[2].y + s.clips[2].h / 2)
    s = await snapshot()
    check('razor: tool C then click cuts a video clip', s.clips.length === 4, s.clips)
    await key('v')

    // 7. Trim the end of the last clip by -72px.
    const last = s.clips.at(-1)
    await click(last.x + 20, last.y + last.h / 2)
    s = await snapshot()
    const before = s.clips.at(-1)
    await drag(before.x + before.w - 3, before.y + before.h / 2, before.x + before.w - 3 - 72, before.y + before.h / 2)
    s = await snapshot()
    const after = s.clips.at(-1)
    check('trim: dragging the end handle shortens the clip by ~1s', Math.abs((before.width - after.width) - 72) < 3, { before: before.width, after: after.width })

    // 8. Move a clip right (and verify history entry exists).
    const mover = s.clips[0]
    await drag(mover.x + 30, mover.y + mover.h / 2, mover.x + 30 + 0, mover.y + mover.h / 2) // click without move = no history change
    const unchanged = await snapshot()
    check('move: a plain click does not move the clip', unchanged.clips[0].left === mover.left, unchanged.clips[0])

    // 8b. Snapping of move and trim (8 px threshold, S toggles, Alt bypasses).
    s = await snapshot()
    const snapClips = s.clips
    const neighbour = snapClips.at(-1) // the trimmed last clip; its end is the snap target
    const neighbourEndPx = neighbour.left + neighbour.width
    const first = snapClips[0]
    const indicator = () => evaluate(`Boolean(document.querySelector('.snap-indicator'))`)
    const moveStartPx = async () => (await snapshot()).clips.at(-1).left
    const dragFirstNearNeighbourEnd = (modifiers = 0, probe = null) => drag(first.x + 30, first.y + first.h / 2, first.x + 30 + neighbourEndPx + 4, first.y + first.h / 2, modifiers, probe)
    let seenIndicator = false
    await dragFirstNearNeighbourEnd(0, async () => { seenIndicator = await indicator() })
    const snappedLeft = await moveStartPx()
    check('snap: moving a clip within 8 px of another clip end lands exactly on that end', Math.abs(snappedLeft - neighbourEndPx) < 0.01, { snappedLeft, neighbourEndPx })
    check('snap: the indicator line shows during a snapping drag and disappears on release', seenIndicator && !(await indicator()), { seenIndicator })
    await key('z', CTRL)
    await dragFirstNearNeighbourEnd(1)
    const altLeft = await moveStartPx()
    check('snap: the same drag with Alt held does not snap', Math.abs(altLeft - neighbourEndPx) > 1.5, { altLeft, neighbourEndPx })
    await key('z', CTRL)
    await key('s')
    await dragFirstNearNeighbourEnd()
    const offLeft = await moveStartPx()
    check('snap: with snapping turned off (S) the drag does not snap', Math.abs(offLeft - neighbourEndPx) > 1.5, { offLeft, neighbourEndPx })
    await key('z', CTRL)
    await key('s')
    s = await snapshot()
    check('snap: undo restored the original clips', s.clips.length === snapClips.length && Math.abs(s.clips[0].left - first.left) < 0.01, s.clips.map((c) => c.left))
    // Trim the end of the long last clip to ~4 px past the playhead.
    await click(secondsX(5), s.ruler.y + 10)
    const playheadPx = await evaluate(`parseFloat(document.querySelector('.playhead-hit-area').style.left)`)
    s = await snapshot()
    const trimTarget = s.clips.at(-1)
    await click(trimTarget.x + 20, trimTarget.y + trimTarget.h / 2)
    const handleX = trimTarget.x + trimTarget.w - 3
    await drag(handleX, trimTarget.y + trimTarget.h / 2, trimTarget.x + playheadPx - trimTarget.left + 4, trimTarget.y + trimTarget.h / 2)
    const trimmedClip = (await snapshot()).clips.at(-1)
    check('snap: trimming a clip end near the playhead ends exactly at the playhead', Math.abs(trimmedClip.left + trimmedClip.width - playheadPx) < 0.01, { end: trimmedClip.left + trimmedClip.width, playheadPx })
    await key('z', CTRL)

    // 9. Delete and ripple delete.
    const beforeDelete = (await snapshot()).clips
    const second = beforeDelete[1]
    await click(second.x + 20, second.y + second.h / 2)
    await key('Delete', SHIFT)
    s = await snapshot()
    check('ripple delete: Shift+Delete removes the clip and closes the gap', s.clips.length === beforeDelete.length - 1 && Math.abs(s.clips[1].left - (beforeDelete[1].left)) < 2, { before: beforeDelete.map((c) => c.left), after: s.clips.map((c) => c.left) })
    check('delete: selection is cleared (Inspector empty)', !s.clips.some((c) => c.selected), s.clips)
    await key('z', CTRL)
    s = await snapshot()
    check('undo after delete restores the clip', s.clips.length === beforeDelete.length, s.clips.length)
    check('undo after delete leaves no stale selection', !s.clips.some((c) => c.selected) && /クリップを選択/.test(s.inspector), { inspector: s.inspector, selected: s.clips.filter((c) => c.selected).length })

    // 10. Track lock respected.
    await evaluate(`document.querySelector('button[aria-label="トラックをロック"]').click()`)
    await sleep(200)
    s = await snapshot()
    const victim = s.clips[0]
    await click(victim.x + 20, victim.y + victim.h / 2)
    await key('Delete')
    s = await snapshot()
    check('lock: Delete on a locked track keeps the clip and tells the user', s.clips.length === beforeDelete.length && /ロック/.test(s.toast), { clips: s.clips.length, toast: s.toast })
    await key('k', CTRL)
    s = await snapshot()
    check('lock: Ctrl+K on a locked track shows a notice instead of an error banner', /ロック/.test(s.toast) && !s.banner, { toast: s.toast, banner: s.banner })
    await evaluate(`document.querySelector('button[aria-label="トラックのロックを解除"]').click()`)

    // 11. Inspector numeric input keeps what is typed.
    await click(victim.x + 20, victim.y + victim.h / 2)
    const typed = await evaluate(`(async () => {
      const label = [...document.querySelectorAll('.inspector .field')].find((f) => f.textContent.startsWith('不透明度'))
      const input = label.querySelector('input'); input.focus(); input.select(); return true })()`)
    for (const ch of '55.5') await send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(200)
    const typedValue = await evaluate(`[...document.querySelectorAll('.inspector .field')].find((f) => f.textContent.startsWith('不透明度')).querySelector('input').value`)
    check('inspector: typing a decimal is not reformatted while focused', typed && typedValue === '55.5', typedValue)
    await evaluate(`document.activeElement.blur()`)
    await sleep(200)
    // Slider focus must not disable shortcuts.
    await evaluate(`(() => { const r = document.querySelector('.inspector input[type=range]'); r?.focus() })()`)
    const pastBefore = (await snapshot()).undoDisabled
    await key('z', CTRL)
    check('shortcuts: Ctrl+Z works while a slider has focus', pastBefore === false, pastBefore)
    await key('y', CTRL)

    // 12. Subtitle add + text edit.
    await click(secondsX(0.5), s.ruler.y + 10)
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('字幕を追加')).click()`)
    await sleep(300)
    await evaluate(`(() => { const t = document.querySelector('.inspector textarea'); t.focus(); t.select() })()`)
    await send('Input.insertText', { text: 'テスト字幕' })
    await sleep(200)
    await evaluate(`document.activeElement.blur()`)
    const caption = await evaluate(`document.querySelector('.inspector textarea')?.value ?? null`)
    check('subtitle: added at playhead and text editable in Inspector', caption === 'テスト字幕', caption)

    // 13. Persistence: recovery write reflects the live project; save to a real file and validate it.
    await sleep(1800)
    const saved = await evaluate(`(async () => {
      const project = await window.spectra.loadRecovery()
      if (!project) return { error: 'no recovery' }
      project.projectPath = ${JSON.stringify(path.join(workspace, 'editing-smoke.spectra'))}
      const result = await window.spectra.saveProject(project, false)
      return { path: result.projectPath, clips: result.project.tracks.flatMap((t) => t.clips).length, offline: result.project.media.some((m) => m.offline) }
    })()`)
    const onDisk = saved.path ? JSON.parse(await readFile(saved.path, 'utf8')) : null
    const diskClips = onDisk?.tracks.flatMap((t) => t.clips) ?? []
    check('save: .spectra written, reloadable, media resolved (not offline)', saved.path && diskClips.length === saved.clips && !saved.offline && onDisk.media[0]?.relativePath, saved)
    check('save: every clip start is an integer microsecond', diskClips.every((c) => Number.isInteger(c.startUs) && Number.isInteger(c.durationUs)), diskClips.map((c) => c.startUs))

    // 14. Linked pair (video on one track, audio on another), loaded through the smoke-mode project hook.
    await evaluate(`(async () => {
      const project = await window.spectra.loadRecovery()
      const track1 = project.tracks.find((t) => t.kind === 'media')
      const video = structuredClone(track1.clips.find((c) => c.kind === 'video'))
      Object.assign(video, { id: 'pair-v', name: 'pair-video', startUs: 2000000, durationUs: 3000000, sourceInUs: 0, linkGroupId: 'pair-g' })
      const audio = structuredClone(video)
      delete audio.transform
      Object.assign(audio, { id: 'pair-a', name: 'pair-audio', kind: 'audio' })
      const track2 = structuredClone(track1)
      Object.assign(track2, { id: 'pair-track-2', name: 'V2', clips: [audio] })
      track1.clips = [video]
      project.tracks = [track1, track2, ...project.tracks.filter((t) => t !== track1 && t.kind !== 'media')]
      window.dispatchEvent(new CustomEvent('spectra:e2e-project', { detail: { project, timeUs: 500000 } }))
    })()`)
    await sleep(500)
    const pair = () => evaluate(`(() => {
      const rect = (id) => { const el = [...document.querySelectorAll('.track-lane .timeline-clip')].find((e) => e.getAttribute('aria-label')?.includes(id)); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, left: parseFloat(el.style.left), width: parseFloat(el.style.width) } }
      return { v: rect('pair-video'), a: rect('pair-audio'), footer: document.querySelector('.timeline-footer code')?.textContent ?? '' }
    })()`)
    let p0 = await pair()
    check('linked pair: loaded as two clips on separate tracks at the same position', p0.v.left === p0.a.left && p0.v.y !== p0.a.y && /^00:00:00:/.test(p0.footer), p0)
    const midY = p0.v.y + p0.v.h / 2
    // (b) A small nudge with the playhead outside the clip: no playhead jump, no snap back to the old start.
    await drag(p0.v.x + 30, midY, p0.v.x + 34, midY)
    let p1 = await pair()
    check('grab: dragging a clip a few px does not move the playhead', p1.footer === p0.footer, { before: p0.footer, after: p1.footer })
    check('grab: a small nudge does not snap back to the original start', Math.abs(p1.v.left - p0.v.left) > 1.5, { before: p0.v.left, after: p1.v.left })
    await key('z', CTRL)
    // (a) Linked partner follows the grabbed clip while the pointer is still down.
    let live
    await drag(p0.v.x + 30, midY, p0.v.x + 30 + 40, midY, 0, async () => { live = await pair() })
    check('linked move: mid-drag the partner is drawn at the grabbed clip position', Math.abs(live.a.left - live.v.left) < 0.01 && Math.abs(live.v.left - (p0.v.left + 40)) < 6, { live, start: p0.v.left })
    p1 = await pair()
    check('linked move: after release the partner is where the preview showed', Math.abs(p1.a.left - live.a.left) < 0.01 && Math.abs(p1.v.left - live.v.left) < 0.01, { live, p1 })
    await key('z', CTRL)
    // Trim: the partner narrows with the grabbed clip.
    const endX = p0.v.x + p0.v.w - 3
    await drag(endX, midY, endX - 36, midY, 0, async () => { live = await pair() })
    check('linked trim: mid-drag the partner width equals the grabbed clip width', Math.abs(live.a.width - live.v.width) < 0.01 && live.v.width < p0.v.width - 20, { live, start: p0.v.width })
    p1 = await pair()
    check('linked trim: after release the partner width equals the preview', Math.abs(p1.a.width - live.a.width) < 0.01 && Math.abs(p1.v.width - live.v.width) < 0.01, { live, p1 })
    await key('z', CTRL)
    // (c) A plain click on a clip still pulls the playhead to the clip start when it is outside the clip.
    p0 = await pair()
    await click(p0.v.x + 40, p0.v.y + p0.v.h / 2)
    p1 = await pair()
    check('click: a plain click on a clip moves an outside playhead to the clip start', /^00:00:02:00/.test(p1.footer), p1.footer)
    check('no unhandled renderer error during the session', !(await snapshot()).banner)
  } finally {
    try { socket?.close() } catch { /* ignore */ }
    child.kill()
    await sleep(500)
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length) throw new Error(`Editing smoke failed ${failed.length}/${results.length}: ${JSON.stringify(failed)}`)
  return { passed: results.length, checks: results.map((r) => r.name) }
}
