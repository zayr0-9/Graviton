/**
 * Delivery surface is separate from the capabilities of the shared Graviton host.
 *
 * The build target (`__BUILD_TARGET__`, defined by vite.config.ts / test configs) is the
 * source of truth, so no `.env` is needed. `VITE_ENVIRONMENT` is still read as a fallback
 * for bundles and tests that stub it instead of defining the target.
 */
const buildTarget: string | undefined = typeof __BUILD_TARGET__ !== 'undefined' ? __BUILD_TARGET__ : undefined
const envMode: string | undefined = import.meta.env.VITE_ENVIRONMENT

export const isNativeShell =
  buildTarget === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) || envMode === 'electron'

export const isBrowserClient = buildTarget === 'browser-client' || envMode === 'browser-client'
export const isStandaloneClient = buildTarget === 'standalone' || envMode === 'standalone'
export const isHostClient = isNativeShell || isBrowserClient || isStandaloneClient
