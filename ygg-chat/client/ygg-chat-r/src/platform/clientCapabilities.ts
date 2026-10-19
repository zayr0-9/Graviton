/** Delivery surface is separate from the capabilities of the shared Graviton host. */
export const isNativeShell =
  (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) || import.meta.env.VITE_ENVIRONMENT === 'electron'

export const isBrowserClient = import.meta.env.VITE_ENVIRONMENT === 'browser-client'
export const isHostClient = isNativeShell || isBrowserClient || import.meta.env.VITE_ENVIRONMENT === 'standalone'
