import type { HookRunTracker } from './hookTypes.js'

// The durable hook-run store (HookRunRepo), configured once at server start. Both recorders —
// Graviton's own runner and Claude Code's native hook events — write through it.
let tracker: HookRunTracker | null = null

export function configureHookRunTracker(next: HookRunTracker | null): void {
  tracker = next
}

export function getHookRunTracker(): HookRunTracker | null {
  return tracker
}
