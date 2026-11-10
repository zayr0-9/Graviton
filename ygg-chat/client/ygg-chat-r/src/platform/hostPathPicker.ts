import { isBrowserClient } from './clientCapabilities'
import { localApi } from '../utils/api'

/** A host path is not a file chosen on the phone. Validate the explicit host path
 * through the existing directory API before updating workspace state. */
export async function selectHostFolder(initialPath = ''): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!isBrowserClient) return await window.electronAPI?.dialog?.selectFolder({ defaultPath: initialPath }) ?? { success: false }
  const path = window.prompt('Folder path on the Graviton host', initialPath)?.trim()
  if (!path) return { success: false }
  try {
    await localApi.get(`/local/files?path=${encodeURIComponent(path)}`)
    return { success: true, path }
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Host folder unavailable' } }
}
