import path from 'node:path'
import { detectPathType, getWSLCommandArgs, isWindows } from '../utils/wslBridge.js'

export function clampTerminalDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback
}

export async function resolveTerminalLaunch(inputCwd?: string) {
  const trimmed = inputCwd?.trim() || process.cwd()
  const normalizedCwd = !isWindows() ? path.resolve(trimmed)
    : detectPathType(trimmed) === 'linux' ? trimmed : path.win32.resolve(trimmed)
  if (!isWindows()) {
    const file = process.env.SHELL?.trim() || '/bin/bash'
    return { file, args: ['-i'], spawnCwd: normalizedCwd, displayCwd: normalizedCwd, shellLabel: path.posix.basename(file) || file }
  }
  if (detectPathType(normalizedCwd) === 'linux') {
    const [file, args] = await getWSLCommandArgs('bash', ['-i'], normalizedCwd)
    return { file, args, spawnCwd: process.cwd(), displayCwd: normalizedCwd, shellLabel: 'wsl bash' }
  }
  const file = process.env.YGG_TERMINAL_SHELL?.trim() || 'powershell.exe'
  const basename = path.win32.basename(file).toLowerCase()
  return { file, args: ['powershell.exe', 'pwsh.exe'].includes(basename) ? ['-NoLogo'] : [],
    spawnCwd: normalizedCwd, displayCwd: normalizedCwd, shellLabel: path.win32.basename(file) || file }
}
