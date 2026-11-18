import { isIPv4 } from 'node:net'
import {
  ALL_IPV4_BIND_HOST, LOOPBACK_BIND_HOST, hostForNetworkBinding,
  type HostNetworkBinding,
} from '../../../shared/hostNetworkBinding.js'

export function parseHostNetworkBinding(raw: unknown): HostNetworkBinding {
  if (!raw || typeof raw !== 'object' || !('mode' in raw)) throw new Error('Select a network binding.')
  if (raw.mode === 'loopback' || raw.mode === 'all') return { mode: raw.mode }
  if (raw.mode === 'custom' && 'address' in raw && typeof raw.address === 'string') {
    const address = raw.address.trim()
    const firstOctet = Number(address.split('.')[0])
    if (isIPv4(address) && firstOctet > 0 && firstOctet !== 127 && firstOctet < 224) {
      return { mode: 'custom', address }
    }
  }
  throw new Error('Enter a LAN IPv4 address without a port, such as 192.168.1.20.')
}

export function readHostNetworkBinding(raw: unknown): HostNetworkBinding {
  try { return parseHostNetworkBinding(raw) }
  catch { return { mode: 'loopback' } }
}

export function customBindingUnavailable(binding: HostNetworkBinding, assignedAddresses: readonly string[]): string | null {
  return binding.mode === 'custom' && !assignedAddresses.includes(binding.address)
    ? `${binding.address} is not assigned to this computer.`
    : null
}

export function resolveHostNetworkBinding(
  saved: HostNetworkBinding,
  env: { host?: string; allowRemote?: string },
  assignedAddresses: readonly string[],
): { bindHost: string; environmentOverride: boolean; startupWarning: string | null } {
  const explicitHost = env.host?.trim()
  const allowRemote = env.allowRemote?.trim()
  if (explicitHost || allowRemote) {
    return {
      bindHost: explicitHost || (/^(1|true|yes|on)$/i.test(allowRemote ?? '') ? ALL_IPV4_BIND_HOST : LOOPBACK_BIND_HOST),
      environmentOverride: true,
      startupWarning: null,
    }
  }
  const unavailable = customBindingUnavailable(saved, assignedAddresses)
  return {
    bindHost: unavailable ? LOOPBACK_BIND_HOST : hostForNetworkBinding(saved),
    environmentOverride: false,
    startupWarning: unavailable ? `${unavailable} Graviton started in local-only mode instead.` : null,
  }
}

export function getRendererBindHost(bindHost: string): string {
  if (bindHost === ALL_IPV4_BIND_HOST) return LOOPBACK_BIND_HOST
  if (bindHost === '::') return '[::1]'
  return bindHost.includes(':') ? `[${bindHost}]` : bindHost
}
