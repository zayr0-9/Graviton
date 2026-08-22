import { describe, expect, it } from 'vitest'
import { buildCorsOriginOption, isLoopbackOrigin } from '../corsPolicy.js'

function evaluate(option: ReturnType<typeof buildCorsOriginOption>, origin: string | undefined): boolean {
  if (typeof option === 'boolean') return option
  let allowed = false
  option(origin, (_err, allow) => {
    allowed = Boolean(allow)
  })
  return allowed
}

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins and rejects the rest', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:3002')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:3002')).toBe(true)
    expect(isLoopbackOrigin('http://192.168.1.20:3002')).toBe(false)
    expect(isLoopbackOrigin('not-a-url')).toBe(false)
  })
})

describe('buildCorsOriginOption', () => {
  it('permissive mode reflects every origin', () => {
    expect(buildCorsOriginOption({ mode: 'permissive', allowedOrigins: [] })).toBe(true)
  })

  it('loopback mode allows loopback and origin-less requests only', () => {
    const option = buildCorsOriginOption({ mode: 'loopback', allowedOrigins: [] })
    expect(evaluate(option, undefined)).toBe(true)
    expect(evaluate(option, 'http://127.0.0.1:5173')).toBe(true)
    expect(evaluate(option, 'http://evil.example.com')).toBe(false)
  })

  it('allowlist mode allows exactly the configured origins plus origin-less requests', () => {
    const option = buildCorsOriginOption({ mode: 'allowlist', allowedOrigins: ['http://dev.example.com:5173'] })
    expect(evaluate(option, undefined)).toBe(true)
    expect(evaluate(option, 'http://dev.example.com:5173')).toBe(true)
    expect(evaluate(option, 'http://127.0.0.1:5173')).toBe(false)
  })
})
