import { describe, expect, it, vi } from 'vitest'
import { createSystemNotifier, normalizeRunNotificationPayload, type NativeNotification } from '../../electron/systemNotifications.js'

// Runs without Electron: the Notification constructor is injected.
const payload = {
  id: 'run-complete:c1:m1', kind: 'primary', title: 'Chat', body: 'Response finished',
  conversationId: 'c1', projectId: 'p1', messageId: 'm1', lineageId: null,
}

const setup = (overrides: { supported?: boolean; focused?: boolean; now?: () => number } = {}) => {
  const created: Array<NativeNotification & { emit: (event: string) => void; options: unknown }> = []
  const activate = vi.fn()
  const notifier = createSystemNotifier({
    isSupported: () => overrides.supported ?? true,
    isAppFocused: () => overrides.focused ?? false,
    activate,
    now: overrides.now,
    createNotification: options => {
      const listeners = new Map<string, () => void>()
      const notification = {
        options,
        on: (event: string, listener: () => void) => { listeners.set(event, listener) },
        show: vi.fn(),
        emit: (event: string) => listeners.get(event)?.(),
      }
      created.push(notification)
      return notification
    },
  })
  return { notifier, created, activate }
}

describe('system run notifications', () => {
  it('shows a notification and activates the run on click', () => {
    const { notifier, created, activate } = setup()
    expect(notifier.show(payload)).toEqual({ shown: true })
    expect(created).toHaveLength(1)
    expect(created[0].options).toEqual({ title: 'Chat', body: 'Response finished', silent: false })
    expect(created[0].show).toHaveBeenCalled()
    created[0].emit('click')
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', messageId: 'm1' }))
  })

  it('skips while the app is focused only when asked to', () => {
    const { notifier } = setup({ focused: true })
    expect(notifier.show(payload, { onlyWhenUnfocused: true })).toEqual({ shown: false, reason: 'focused' })
    expect(notifier.show(payload, { onlyWhenUnfocused: false })).toEqual({ shown: true })
  })

  it('shows one notification per run across windows, until the window expires', () => {
    let now = 0
    const { notifier } = setup({ now: () => now })
    expect(notifier.show(payload)).toEqual({ shown: true })
    expect(notifier.show(payload)).toEqual({ shown: false, reason: 'duplicate' })
    now += 7 * 60 * 60 * 1000
    expect(notifier.show(payload)).toEqual({ shown: true })
  })

  it('force bypasses the focus gate and de-duplication (Settings test button)', () => {
    const { notifier } = setup({ focused: true })
    notifier.show(payload, { force: true })
    expect(notifier.show(payload, { force: true, onlyWhenUnfocused: true })).toEqual({ shown: true })
  })

  it('reports unsupported systems and invalid payloads', () => {
    expect(setup({ supported: false }).notifier.show(payload)).toEqual({ shown: false, reason: 'unsupported' })
    expect(setup().notifier.show({ ...payload, kind: 'subagent' })).toEqual({ shown: false, reason: 'invalid' })
  })
})

describe('normalizeRunNotificationPayload', () => {
  it('requires ids and a known kind', () => {
    expect(normalizeRunNotificationPayload(null)).toBeNull()
    expect(normalizeRunNotificationPayload({ ...payload, conversationId: '' })).toBeNull()
    expect(normalizeRunNotificationPayload({ ...payload, messageId: { evil: true } })).toBeNull()
  })

  it('clips long text and defaults an empty title', () => {
    const normalized = normalizeRunNotificationPayload({ ...payload, title: '   ', body: 'x'.repeat(500) })
    expect(normalized?.title).toBe('Graviton')
    expect(normalized?.body).toHaveLength(240)
    expect(normalized?.body.endsWith('…')).toBe(true)
  })

  it('accepts numeric ids as strings', () => {
    expect(normalizeRunNotificationPayload({ ...payload, conversationId: 42, projectId: 7 })).toMatchObject({
      conversationId: '42', projectId: '7',
    })
  })
})
