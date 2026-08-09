import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_ERROR_DEFAULTS, type ChatErrorCode } from '../../../../../shared/chatErrors'
import {
  attachLocalChatErrorCode,
  buildChatErrorRecord,
  classifyLocalChatError,
  reportLocalChatError,
} from './localChatErrors'

/** The node test runtime exposes a getter-only `navigator` with no `onLine`. */
function setOnline(onLine: boolean | undefined) {
  vi.stubGlobal('navigator', onLine === undefined ? {} : { onLine })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyLocalChatError — offline beats everything', () => {
  const cases: Array<{ label: string; error: unknown; ctx?: Parameters<typeof classifyLocalChatError>[1] }> = [
    { label: 'a fetch rejection', error: new TypeError('Failed to fetch') },
    { label: 'a 500 open', error: new Error('Headless chat request failed (HTTP 500)'), ctx: { phase: 'open', status: 500 } },
    { label: 'a 401 open', error: new Error('unauthorized'), ctx: { phase: 'open', status: 401 } },
    { label: 'a 410 reattach', error: new Error('gone'), ctx: { phase: 'reattach', status: 410 } },
    { label: 'a failed /resume', error: new Error('boom'), ctx: { phase: 'resume' } },
    { label: 'a failed /abort', error: new Error('boom'), ctx: { phase: 'abort' } },
    { label: 'a stream with no terminal event', error: new Error('Headless stream ended without a terminal event'), ctx: { phase: 'stream' } },
    { label: 'a non-Electron runtime', error: new Error('The server-owned chat loop requires Electron.'), ctx: { phase: 'preflight' } },
    { label: 'a watchdog code passed directly', error: null, ctx: { code: 'stream_stalled' } },
    { label: 'an internal programming error', error: new Error('Internal error: no active parent id') },
  ]

  for (const { label, error, ctx } of cases) {
    it(`classifies ${label} as offline when navigator.onLine is false`, () => {
      setOnline(false)
      expect(classifyLocalChatError(error, ctx).code).toBe('offline')
    })
  }

  it('does not treat an unknown navigator as offline', () => {
    setOnline(undefined)
    expect(classifyLocalChatError(new TypeError('Failed to fetch')).code).toBe('local_server_unreachable')
  })

  it('does not treat an online device as offline', () => {
    setOnline(true)
    expect(classifyLocalChatError(new TypeError('Failed to fetch')).code).toBe('local_server_unreachable')
  })
})

describe('classifyLocalChatError — no raw message ever reaches userMessage', () => {
  const secrets = [
    'Internal error: no active parent id',
    'Provider turn 7/400 exceeded for lineage 0f9c-aa12',
    'Headless chat request failed (HTTP 500): {"error":"ENOENT /Users/karansingh/.ygg/db.sqlite"}',
    'Cannot read properties of undefined (reading \'lineageId\')',
    'Local server not available at http://127.0.0.1:3002. Please ensure the Electron app is running',
    'Headless stream ended without a terminal event',
  ]

  const phases = [undefined, 'open', 'stream', 'reattach', 'resume', 'abort', 'preflight'] as const
  const statuses = [undefined, 400, 401, 404, 410, 429, 500, 503]
  const onlineStates = [true, undefined] as const

  it('never copies the raw text into userMessage, on any phase/status/online combination', () => {
    for (const online of onlineStates) {
      setOnline(online)
      for (const raw of secrets) {
        for (const phase of phases) {
          for (const status of statuses) {
            const envelope = classifyLocalChatError(new Error(raw), { phase, status })
            expect(envelope.userMessage).not.toContain(raw)
            // The prose must be one of the sanctioned defaults, verbatim.
            expect(envelope.userMessage).toBe(CHAT_ERROR_DEFAULTS[envelope.code].userMessage)
            // ...and the raw text is preserved, but only in detail.
            expect(envelope.detail).toContain(raw)
          }
        }
      }
    }
  })

  it('keeps stack text and non-Error throws out of userMessage', () => {
    setOnline(true)
    const weird = { message: 'at Object.<anonymous> (/Users/karansingh/secret.ts:12:9)', status: 500 }
    const envelope = classifyLocalChatError(weird)
    expect(envelope.userMessage).toBe(CHAT_ERROR_DEFAULTS.server_rejected_request.userMessage)
    expect(envelope.userMessage).not.toContain('secret.ts')
    expect(envelope.detail).toContain('secret.ts')
  })

  it('truncates very long raw text in detail', () => {
    setOnline(true)
    const envelope = classifyLocalChatError(new Error('x'.repeat(5000)))
    expect(envelope.detail!.length).toBeLessThanOrEqual(601)
  })

  it('always returns a complete, renderable envelope', () => {
    setOnline(true)
    for (const error of [null, undefined, '', 0, new Error(''), {}, []]) {
      const envelope = classifyLocalChatError(error)
      expect(envelope.userMessage.trim().length).toBeGreaterThan(0)
      expect(['retryable', 'user_action', 'fatal']).toContain(envelope.recoverability)
      expect(CHAT_ERROR_DEFAULTS[envelope.code]).toBeDefined()
    }
  })
})

describe('classifyLocalChatError — discriminators', () => {
  it('maps a POST fetch rejection to local_server_unreachable', () => {
    setOnline(true)
    expect(classifyLocalChatError(new TypeError('Failed to fetch'), { phase: 'open' }).code).toBe(
      'local_server_unreachable'
    )
    expect(classifyLocalChatError(new TypeError('NetworkError when attempting to fetch resource')).code).toBe(
      'local_server_unreachable'
    )
  })

  it('maps POST non-2xx by status', () => {
    setOnline(true)
    expect(classifyLocalChatError(new Error('nope'), { phase: 'open', status: 400 }).code).toBe('server_rejected_request')
    expect(classifyLocalChatError(new Error('nope'), { phase: 'open', status: 401 }).code).toBe('session_expired')
    expect(classifyLocalChatError(new Error('nope'), { phase: 'open', status: 500 }).code).toBe('server_rejected_request')
    expect(classifyLocalChatError(new Error('nope'), { phase: 'open', status: 503 }).status).toBe(503)
  })

  it('reads the status out of the mainChatClient throw when ctx has none', () => {
    setOnline(true)
    const envelope = classifyLocalChatError(new Error('Headless chat request failed (HTTP 401): expired'), {
      phase: 'open',
    })
    expect(envelope.code).toBe('session_expired')
    expect(envelope.status).toBe(401)
  })

  it('maps the mainChatClient no-terminal-event throw to stream_interrupted', () => {
    setOnline(true)
    expect(classifyLocalChatError(new Error('Headless stream ended without a terminal event'), { phase: 'stream' }).code).toBe(
      'stream_interrupted'
    )
  })

  it('maps a 410 on reattach/resubscribe to run_expired', () => {
    setOnline(true)
    expect(classifyLocalChatError(new Error('gone'), { phase: 'reattach', status: 410 }).code).toBe('run_expired')
    expect(
      classifyLocalChatError(new Error('The server-owned run is no longer available (it was cancelled or expired).'), {
        phase: 'stream',
      }).code
    ).toBe('run_expired')
  })

  it('maps a failed /resume to decision_not_delivered and a failed /abort to stop_not_confirmed', () => {
    setOnline(true)
    expect(classifyLocalChatError(new TypeError('Failed to fetch'), { phase: 'resume' }).code).toBe(
      'decision_not_delivered'
    )
    expect(classifyLocalChatError(new TypeError('Failed to fetch'), { phase: 'abort' }).code).toBe('stop_not_confirmed')
  })

  it('lets a definite status still win over the resume/abort phase', () => {
    setOnline(true)
    expect(classifyLocalChatError(new Error('gone'), { phase: 'resume', status: 410 }).code).toBe('run_expired')
    expect(classifyLocalChatError(new Error('nope'), { phase: 'abort', status: 401 }).code).toBe('session_expired')
  })

  it('honours a code the caller passes directly (idle watchdog)', () => {
    setOnline(true)
    expect(classifyLocalChatError(null, { code: 'stream_stalled', phase: 'stream' }).code).toBe('stream_stalled')
  })

  it('honours a code attached at the throw site', () => {
    setOnline(true)
    const error = attachLocalChatErrorCode(new Error('whatever'), 'history_truncated')
    expect(classifyLocalChatError(error).code).toBe('history_truncated')
  })

  it('ignores an unknown attached code rather than emitting an unrenderable one', () => {
    setOnline(true)
    const error = Object.assign(new Error('Headless stream ended without a terminal event'), {
      chatErrorCode: 'not_a_real_code',
    })
    expect(classifyLocalChatError(error).code).toBe('stream_interrupted')
  })

  it('maps the non-Electron throw to unsupported_runtime, which is fatal', () => {
    setOnline(true)
    const envelope = classifyLocalChatError(new Error('The server-owned chat loop requires Electron.'), {
      phase: 'preflight',
    })
    expect(envelope.code).toBe('unsupported_runtime')
    expect(envelope.recoverability).toBe('fatal')
    expect(envelope.action).toBeUndefined()
  })

  it('falls back to internal_error for a genuine programming error', () => {
    setOnline(true)
    const envelope = classifyLocalChatError(new Error('Internal error: no active parent id'))
    expect(envelope.code).toBe('internal_error')
    expect(envelope.detail).toContain('no active parent id')
  })

  it('treats an unexplained mid-stream failure as an interruption, not an internal bug', () => {
    setOnline(true)
    expect(classifyLocalChatError(new Error('reader closed'), { phase: 'stream' }).code).toBe('stream_interrupted')
  })
})

describe('buildChatErrorRecord / reportLocalChatError', () => {
  it('builds a record without touching chatSlice', () => {
    setOnline(true)
    const envelope = classifyLocalChatError(new Error('boom'))
    const record = buildChatErrorRecord(envelope, {
      conversationId: 'conv-1',
      parentMessageId: 'msg-9',
      streamId: 'stream-3',
      lineageId: 'lin-2',
      id: 'fixed-id',
      createdAt: 1234,
    })
    expect(record).toEqual({
      id: 'fixed-id',
      conversationId: 'conv-1',
      envelope,
      parentMessageId: 'msg-9',
      streamId: 'stream-3',
      lineageId: 'lin-2',
      createdAt: 1234,
      dismissed: false,
    })
  })

  it('defaults the optional anchors to null and mints an id', () => {
    setOnline(true)
    const record = buildChatErrorRecord(classifyLocalChatError(new Error('boom')), { conversationId: 'conv-1' })
    expect(record.parentMessageId).toBeNull()
    expect(record.streamId).toBeNull()
    expect(record.lineageId).toBeNull()
    expect(record.id).toMatch(/^chat-error-/)
    expect(record.dismissed).toBe(false)
  })

  it('classifies, builds and hands the record to the caller-supplied emitter', () => {
    setOnline(true)
    const emit = vi.fn((record: { id: string }) => record.id)
    const { envelope, record, emitted } = reportLocalChatError(
      new Error('Headless chat request failed (HTTP 401)'),
      { conversationId: 'conv-1', streamId: 'stream-3', phase: 'open', id: 'fixed-id' },
      emit
    )
    expect(envelope.code).toBe('session_expired')
    expect(envelope.action).toEqual({ kind: 'sign_in', label: 'Sign in' })
    expect(record.streamId).toBe('stream-3')
    expect(emit).toHaveBeenCalledWith(record)
    expect(emitted).toBe('fixed-id')
  })

  it('never lets a raw message reach the record envelope prose', () => {
    setOnline(true)
    const raw = 'Internal error: no active parent id'
    const { record } = reportLocalChatError(new Error(raw), { conversationId: 'conv-1' })
    expect(record.envelope.userMessage).not.toContain(raw)
    expect(record.envelope.userMessage).toBe(CHAT_ERROR_DEFAULTS.internal_error.userMessage)
    expect(record.envelope.detail).toContain(raw)
  })
})

describe('every code this classifier can emit has prose', () => {
  it('resolves to a known ChatErrorCode', () => {
    const emitted: ChatErrorCode[] = [
      'offline',
      'local_server_unreachable',
      'server_rejected_request',
      'session_expired',
      'stream_interrupted',
      'run_expired',
      'decision_not_delivered',
      'stop_not_confirmed',
      'stream_stalled',
      'unsupported_runtime',
      'internal_error',
      'cancelled',
      'rate_limited',
    ]
    for (const code of emitted) {
      expect(CHAT_ERROR_DEFAULTS[code]?.userMessage?.trim().length).toBeGreaterThan(0)
    }
  })
})
