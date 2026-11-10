/**
 * Delivery surface is separate from the capabilities of the shared Graviton host.
 * Derived only from the build target (`__BUILD_TARGET__`, defined by vite.config.ts and the
 * test/smoke configs), so no `.env` is ever needed.
 */
const buildTarget: string | undefined = typeof __BUILD_TARGET__ !== 'undefined' ? __BUILD_TARGET__ : undefined

export const isNativeShell = buildTarget === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)
export const isBrowserClient = buildTarget === 'browser-client'
export const isStandaloneClient = buildTarget === 'standalone'
export const isHostClient = isNativeShell || isBrowserClient || isStandaloneClient
