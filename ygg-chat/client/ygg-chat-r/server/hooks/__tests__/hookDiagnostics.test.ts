import { describe, expect, it } from 'vitest'
import { redactHookDiagnostic } from '../hookDiagnostics.js'

describe('hook diagnostics redaction', () => {
  it('redacts common credentials before persistence', () => {
    const value = redactHookDiagnostic('Authorization: Bearer abc.def token=secret password=hunter2 https://user:pass@example.test/x')
    expect(value).not.toContain('abc.def')
    expect(value).not.toContain('secret')
    expect(value).not.toContain('hunter2')
    expect(value).not.toContain('user:pass')
    expect(value).toContain('[redacted]')
  })

  it('bounds previews', () => {
    const value = redactHookDiagnostic('x'.repeat(100), 40)
    expect(value?.length).toBeLessThanOrEqual(40)
    expect(value).toContain('truncated')
  })
})
