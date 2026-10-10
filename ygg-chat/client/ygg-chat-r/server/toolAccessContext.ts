import { AsyncLocalStorage } from 'node:async_hooks'

// Trusted, invocation-local policy. Never read this capability from model tool arguments.
const toolAccess = new AsyncLocalStorage<boolean>()

export const hasFullToolAccess = (): boolean => toolAccess.getStore() === true

export function withToolAccess<T>(fullAccess: boolean | undefined, run: () => T): T {
  return toolAccess.run(fullAccess === true, run)
}
