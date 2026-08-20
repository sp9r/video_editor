export const descendantProcessIds = (rootPid, processes) => {
  const owned = new Set([Number(rootPid)])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (owned.has(Number(process.parentPid)) && !owned.has(Number(process.pid))) {
        owned.add(Number(process.pid))
        changed = true
      }
    }
  }
  return owned
}

export const classifyOwnedProcess = (process, rootPid) => {
  if (Number(process.pid) === Number(rootPid)) return 'main'
  const commandLine = String(process.commandLine ?? '').toLowerCase()
  const name = String(process.name ?? '').toLowerCase()
  if (name.includes('ffmpeg') || commandLine.includes('ffmpeg')) return 'ffmpeg'
  if (commandLine.includes('--type=renderer')) return 'renderer'
  if (commandLine.includes('--type=gpu-process')) return 'gpu'
  if (commandLine.includes('--type=utility') || commandLine.includes('--utility-sub-type')) return 'utility'
  return 'other-electron'
}

export const aggregateOwnedProcessSample = (rootPid, processes) => {
  const ownedIds = descendantProcessIds(rootPid, processes)
  const roles = ['main', 'renderer', 'gpu', 'utility', 'other-electron', 'ffmpeg']
  const cpuByRole = Object.fromEntries(roles.map((role) => [role, 0]))
  const workingSetBytesByRole = Object.fromEntries(roles.map((role) => [role, 0]))
  const privateBytesByRole = Object.fromEntries(roles.map((role) => [role, 0]))
  let ffmpegProcessCount = 0
  for (const process of processes) {
    if (!ownedIds.has(Number(process.pid))) continue
    const role = classifyOwnedProcess(process, rootPid)
    cpuByRole[role] += Number(process.cpuSeconds) || 0
    workingSetBytesByRole[role] += Number(process.workingSetBytes) || 0
    privateBytesByRole[role] += Number(process.privateBytes) || 0
    if (role === 'ffmpeg') ffmpegProcessCount += 1
  }
  const sum = (values) => roles.reduce((total, role) => total + values[role], 0)
  return {
    ownedProcessIds: [...ownedIds].sort((left, right) => left - right),
    cpuByRole,
    workingSetBytesByRole,
    privateBytesByRole,
    cpuSeconds: sum(cpuByRole),
    workingSetBytes: sum(workingSetBytesByRole),
    privateBytes: sum(privateBytesByRole),
    ffmpegProcessCount
  }
}

export const diffRoleCpuPercent = (first, last, elapsedSeconds, logicalCpus) => {
  const roles = Object.keys(last ?? first ?? {})
  const divisor = Math.max(0.001, elapsedSeconds) * Math.max(1, logicalCpus)
  return Object.fromEntries(roles.map((role) => [role, Math.max(0, ((Number(last?.[role]) || 0) - (Number(first?.[role]) || 0)) / divisor * 100)]))
}
