/**
 * Test-only side-effect shim: provides a minimal in-memory `localStorage` for
 * node-environment vitest runs. Some renderer modules (e.g. chatSlice) read
 * localStorage at import time to build their initial state; in the browser /
 * Electron runtime this is always present, but the node test env has none.
 *
 * Import this FIRST (before any module that touches localStorage) in a test file.
 */

if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      store.set(key, String(value))
    },
    removeItem: (key: string): void => {
      store.delete(key)
    },
    clear: (): void => {
      store.clear()
    },
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    get length(): number {
      return store.size
    },
  }
}

export {}
