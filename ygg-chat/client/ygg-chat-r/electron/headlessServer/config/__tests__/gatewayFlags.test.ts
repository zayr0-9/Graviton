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

  it('defaults every flag OFF with no env override and no Conf keys set', () => {
    expect(resolveGatewayFlags()).toEqual({ chat: false, tokenOwner: false })
  })

  it('YGG_GATEWAY_MODE truthy is a master override that turns every flag on', () => {
    for (const truthy of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.YGG_GATEWAY_MODE = truthy
      expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: true })
    }
  })

  it('treats a non-truthy env value as off (falls through to Conf defaults)', () => {
    process.env.YGG_GATEWAY_MODE = 'off'
    expect(resolveGatewayFlags()).toEqual({ chat: false, tokenOwner: false })
  })

  it('reads each flag independently from its Conf key (only === true enables)', () => {
    mockConf.get = key => (key === 'gateway.chat' ? true : undefined)
    expect(resolveGatewayFlags()).toEqual({ chat: true, tokenOwner: false })

    mockConf.get = key => (key === 'gateway.tokenOwner' ? true : 'truthy-but-not-boolean')
    // A non-boolean truthy value must NOT enable (guards against loose Conf values).
    expect(resolveGatewayFlags()).toEqual({ chat: false, tokenOwner: true })
  })

  it('a corrupt/unreadable Conf store must never throw at startup — stays default-off', () => {
    mockConf.throws = true
    expect(() => resolveGatewayFlags()).not.toThrow()
    expect(resolveGatewayFlags()).toEqual({ chat: false, tokenOwner: false })
  })
})
