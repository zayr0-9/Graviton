import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../platform/clientCapabilities', () => ({ isHostClient: true, isBrowserClient: true }))
vi.mock('../config/runtimeMode', () => ({ isElectronMode: false }))
import { isResumableRunsEnabled } from './serverLoopSettings'
afterEach(() => vi.unstubAllGlobals())
describe('shared host lifetime', () => {
  it('requires server cancellation/reconnect even when an old browser opted out', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'false' })
    expect(isResumableRunsEnabled()).toBe(true)
  })
})
