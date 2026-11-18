import { describe, expect, it, vi } from 'vitest'
import type { StreamState } from './chatTypes'
import { createEmptyStreamState } from './streamHelpers'
import {
  buildSystemRunNotification,
  getSystemNotificationHref,
  showSystemRunNotification,
  type SystemRunNotificationPayload,
} from './systemRunNotifications'

const live = (overrides: Partial<StreamState> = {}): StreamState => ({
  ...createEmptyStreamState(overrides.streamType ?? 'primary'),
  active: true,
  status: 'active',
  conversationId: 'c1',
  ...overrides,
})

const conversations = [{ id: 'c1', title: '  Release notes  ', project_id: 'p1' }]

describe('buildSystemRunNotification', () => {
  it('notifies for a live main Chat run', () => {
    expect(buildSystemRunNotification(live(), 'm9', conversations)).toEqual({
      id: 'run-complete:c1:m9',
      kind: 'primary',
      title: 'Release notes',
      body: 'Response finished',
      conversationId: 'c1',
      projectId: 'p1',
      messageId: 'm9',
      lineageId: null,
    })
  })

  it('notifies for a branch run and carries its confirmed lineage', () => {
    const payload = buildSystemRunNotification(
      live({ streamType: 'branch', lineage: { lineageId: 'L1', lineageIdConfirmed: true } }), 'm2', conversations)
    expect(payload).toMatchObject({ kind: 'branch', body: 'Branch run finished', lineageId: 'L1' })
  })

  it('ignores an unconfirmed lineage', () => {
    const payload = buildSystemRunNotification(
      live({ streamType: 'branch', lineage: { lineageId: 'L1', lineageIdConfirmed: false } }), 'm2', conversations)
    expect(payload?.lineageId).toBeNull()
  })

  it.each(['subagent', 'tool'] as const)('does not notify for %s streams', streamType => {
    expect(buildSystemRunNotification(live({ streamType }), 'm1', conversations)).toBeNull()
  })

  it('does not notify for a replay of an already finished run', () => {
    expect(buildSystemRunNotification(live({ active: false }), 'm1', conversations)).toBeNull()
    expect(buildSystemRunNotification(live({ finished: true }), 'm1', conversations)).toBeNull()
    expect(buildSystemRunNotification(live({ status: 'completed' }), 'm1', conversations)).toBeNull()
  })

  it('needs a stream, a message and a conversation', () => {
    expect(buildSystemRunNotification(undefined, 'm1', conversations)).toBeNull()
    expect(buildSystemRunNotification(live(), undefined, conversations)).toBeNull()
    expect(buildSystemRunNotification(live({ conversationId: null }), 'm1', conversations)).toBeNull()
  })

  it('falls back to the app name for an unknown or untitled conversation', () => {
    expect(buildSystemRunNotification(live(), 'm1', [])).toMatchObject({ title: 'Graviton', projectId: null })
  })
})

describe('showSystemRunNotification', () => {
  const payload = buildSystemRunNotification(live(), 'm1', conversations)
  const api = () => ({ show: vi.fn(() => Promise.resolve({ shown: true })), takeActivation: vi.fn(), onActivated: vi.fn() })

  it('passes the focus preference to main', () => {
    const notifications = api()
    expect(showSystemRunNotification(payload, { enabled: true, when: 'unfocused' }, notifications)).toBe(true)
    expect(notifications.show).toHaveBeenCalledWith(payload, { onlyWhenUnfocused: true })
    showSystemRunNotification(payload, { enabled: true, when: 'always' }, notifications)
    expect(notifications.show).toHaveBeenLastCalledWith(payload, { onlyWhenUnfocused: false })
  })

  it('does nothing when turned off, without a payload, or without the Electron bridge', () => {
    const notifications = api()
    expect(showSystemRunNotification(payload, { enabled: false, when: 'always' }, notifications)).toBe(false)
    expect(showSystemRunNotification(null, { enabled: true, when: 'always' }, notifications)).toBe(false)
    expect(showSystemRunNotification(payload, { enabled: true, when: 'always' }, null)).toBe(false)
    expect(notifications.show).not.toHaveBeenCalled()
  })

  it('swallows a rejected IPC call', async () => {
    const notifications = { ...api(), show: vi.fn(() => Promise.reject(new Error('no handler'))) }
    expect(showSystemRunNotification(payload, { enabled: true, when: 'always' }, notifications)).toBe(true)
    await Promise.resolve()
  })
})

describe('getSystemNotificationHref', () => {
  const base: SystemRunNotificationPayload = {
    id: 'x', kind: 'primary', title: 't', body: 'b', conversationId: 'c1', projectId: 'p1', messageId: 'm1', lineageId: null,
  }

  it('opens the completed response', () => {
    expect(getSystemNotificationHref(base)).toBe('/chat/p1/c1#m1')
  })

  it('opens the confirmed fork focused on the response', () => {
    expect(getSystemNotificationHref({ ...base, lineageId: 'L1' })).toBe('/chat/p1/c1/lineage/L1?focus=m1')
  })
})
