export const SHELL_CLEANUP_GRACE_MS = 300
export const SHELL_RUNTIME_MARGIN_MS = 1000

/** Zero is not an unlimited execution request. */
export function normalizeShellTimeoutMs(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(180_000, Math.floor(value)))
    : 180_000
}
