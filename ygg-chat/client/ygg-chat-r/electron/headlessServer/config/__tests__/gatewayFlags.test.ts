import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable Conf mock so the default (non-env) path can be steered per-test without
// touching the real user config file. vi.hoisted keeps the state usable inside the
// hoisted vi.mock factory.
const mockConf = vi.hoisted(() => ({
  get: (_key: string) => undefined as unknown,
  throws: false,
}))

vi.mock('conf', () => ({
  default: class {
    constructor() {
      if (mockConf.throws) throw new Error('corrupt conf store')
    }
    get(key: string) {
      return mockConf.get(key)
    }
  },
}))

import { resolveGatewayFlags } from '../gatewayFlags.js'

describe('resolveGatewayFlags', () => {
  const saved = process.env.YGG_GATEWAY_MODE

  beforeEach(() => {
    delete process.env.YGG_GATEWAY_MODE
    mockConf.get = () => undefined
    mockConf.throws = false
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.YGG_GATEWAY_MODE
    else process.env.YGG_GATEWAY_MODE = saved
  })

  it('defaults chat and resumable runs ON with no env override and no Conf keys set', () => {
    // Phase 6 cutover: chat defaults ON (renderer routes all chat server-side).
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: true })
  })

  it('YGG_GATEWAY_MODE truthy is a master override that turns every flag on', () => {
    for (const truthy of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.YGG_GATEWAY_MODE = truthy
      expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: true, crud: true, cloudProxy: true, resumableRuns: true })
    }
  })

  it('treats a non-truthy env value as off (falls through to Conf defaults: chat/resumable on)', () => {
    process.env.YGG_GATEWAY_MODE = 'off'
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: true })
  })

  it('an explicit gateway.chat === false Conf key forces chat off (the escape hatch)', () => {
    mockConf.get = key => (key === 'gateway.chat' ? false : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: false, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: true })
  })

  it('chat stays on for any non-false chat value; other flags need === true', () => {
    // chat uses `!== false`, so a loose truthy value keeps it on (it is on by default).
    mockConf.get = key => (key === 'gateway.tokenOwner' ? true : 'truthy-but-not-boolean')
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: true, crud: false, cloudProxy: false, resumableRuns: true })

    // A non-boolean truthy value must NOT enable the === true flags.
    mockConf.get = key => (key === 'gateway.crud' ? 'truthy-but-not-boolean' : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: true })
  })

  it('reads the Phase 5 crud + cloudProxy keys independently (only === true enables)', () => {
    mockConf.get = key => (key === 'gateway.crud' ? true : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: true, cloudProxy: false, resumableRuns: true })

    mockConf.get = key => (key === 'gateway.cloudProxy' ? true : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: true, resumableRuns: true })

    mockConf.get = key => (key === 'gateway.crud' || key === 'gateway.cloudProxy' ? true : 0)
    // chat: 0 !== false => stays on.
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: true, cloudProxy: true, resumableRuns: true })
  })

  it('reads gateway.resumableRuns independently and only explicit false opts out', () => {
    mockConf.get = key => (key === 'gateway.resumableRuns' ? false : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: false })

    mockConf.get = key => (key === 'gateway.resumableRuns' ? 'yes' : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: true })
  })

  it('a corrupt/unreadable Conf store must never throw at startup — keeps chat/resumable on', () => {
    mockConf.throws = true
    expect(() => resolveGatewayFlags()).not.toThrow()
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false, crud: false, cloudProxy: false, resumableRuns: true })
  })
})
