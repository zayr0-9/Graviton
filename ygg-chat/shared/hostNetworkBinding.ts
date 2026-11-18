export const LOOPBACK_BIND_HOST = '127.0.0.1'
export const ALL_IPV4_BIND_HOST = '0.0.0.0'

export type HostNetworkBinding =
  | { mode: 'loopback' }
  | { mode: 'all' }
  | { mode: 'custom'; address: string }

export type HostNetworkBindingStatus = {
  saved: HostNetworkBinding
  environmentOverride: boolean
  restartRequired: boolean
  startupWarning: string | null
}

export function hostForNetworkBinding(binding: HostNetworkBinding): string {
  switch (binding.mode) {
    case 'loopback': return LOOPBACK_BIND_HOST
    case 'all': return ALL_IPV4_BIND_HOST
    case 'custom': return binding.address
  }
}
