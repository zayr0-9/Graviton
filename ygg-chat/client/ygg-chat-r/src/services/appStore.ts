import { isCommunityMode } from '../config/runtimeMode'
import { supabase } from '../lib/supabase'
import { buildLocalApiUrl, environment, localApi, publicApiCall } from '../utils/api'

const APP_STORE_BUCKET = 'updates'
const APP_STORE_ROOT = 'apps'

const assertCloudAppStoreWriteEnabled = () => {
  if (isCommunityMode) {
    throw new Error('Cloud app store publishing is disabled in community mode.')
  }
}

export interface AppStoreDescription {
  name?: string
  title?: string
  description?: string
  shortDescription?: string
  publisher?: string
  version?: string
  size?: number | string
  tags?: string[]
  category?: string
  icon?: string
  iconUrl?: string
  zip?: string
  zipFile?: string
  archive?: string
  bundle?: string
  file?: string
  download?: string
  gitLink?: string
}

export interface AppUploader {
  id?: string | null
  username?: string | null
}

export interface AppStoreApp {
  id: string
  name: string
  description: AppStoreDescription
  descriptionUrl: string | null
  zipName: string | null
  zipUrl: string | null
  updatedAt: string | null
  source?: 'first-party' | 'community'
  containsExecutables?: boolean
  uploader?: AppUploader
}

export interface AppStoreInstallResult {
  success: boolean
  message?: string
  error?: string
  restartRequired?: boolean
  toolCount?: number
  extracted?: number
  skipped?: number
  mode?: 'install' | 'update'
  preservedResources?: number
}

export interface AppStoreUninstallResult {
  success: boolean
  message?: string
  error?: string
  restartRequired?: boolean
  toolCount?: number
}

export interface CustomToolDefinition {
  name: string
  version?: string
  description?: string
  appPermissions?: {
    agent?: 'read' | 'write'
  }
  jsRuntimeMode?: 'electron' | 'custom' | 'none'
  jsRuntimes?: string
  sourcePath?: string
}

export interface CustomToolDefinitionFile {
  name: string
  description: string
  version?: string
  enabled?: boolean
  appPermissions?: {
    agent?: 'read' | 'write'
  }
  jsRuntimeMode?: 'electron' | 'custom' | 'none'
  jsRuntimes?: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

export interface CommunityAppUploadValidation {
  success: boolean
  error?: string
  warnings?: string[]
  appId?: string
  toolDir?: string
  description?: AppStoreDescription
  definition?: CustomToolDefinitionFile
  containsExecutables?: boolean
}

type PublicAppApiRecord = {
  app_id: string
  description: AppStoreDescription
  description_url: string
  zip_url: string
  contains_executables: boolean
  created_at?: string | null
  updated_at?: string | null
  uploader_user_id?: string | null
  uploader?: { username?: string | null }
}

export type AppStoreManifestEntry =
  | string
  | (AppStoreDescription & {
      id: string
      descriptionUrl?: string
      zipUrl?: string
      updatedAt?: string
    })

type AppStoreManifestEntryObject = AppStoreDescription & {
  id: string
  descriptionUrl?: string
  zipUrl?: string
  updatedAt?: string
}

export interface AppStoreManifest {
  apps: AppStoreManifestEntry[]
}

const isAbsoluteUrl = (value: string) => /^https?:\/\//i.test(value)

const resolveZipHint = (description?: AppStoreDescription | null): string | null => {
  if (!description) return null
  return (
    description.zip ||
    description.zipFile ||
    description.archive ||
    description.bundle ||
    description.file ||
    description.download ||
    null
  )
}

const parseManifest = (data: unknown): AppStoreManifestEntry[] | null => {
  if (Array.isArray(data)) return data as AppStoreManifestEntry[]
  if (data && typeof data === 'object' && Array.isArray((data as AppStoreManifest).apps)) {
    return (data as AppStoreManifest).apps
  }
  return null
}

export async function fetchAppStoreApps(): Promise<AppStoreApp[]> {
  if (!supabase) {
    throw new Error('Supabase client not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  }

  const storage = supabase.storage.from(APP_STORE_BUCKET)
  const manifestPath = `${APP_STORE_ROOT}/manifest.json`
  const manifestUrl = storage.getPublicUrl(manifestPath).data.publicUrl
  let manifestEntries: AppStoreManifestEntry[] | null = null

  try {
    const response = await fetch(manifestUrl, { cache: 'no-store' })
    if (response.ok) {
      manifestEntries = parseManifest(await response.json())
    }
  } catch {
    // Ignore manifest fetch errors; handled below
  }

  if (!manifestEntries || manifestEntries.length === 0) {
    throw new Error('App store manifest is missing or empty.')
  }

  const apps = await Promise.all(
    manifestEntries.map(async entry => {
      const isStringEntry = typeof entry === 'string'
      const appId = isStringEntry ? entry : entry.id
      if (!appId) {
        throw new Error('Manifest entry is missing an id.')
      }

      let manifestDescriptionUrl: string | undefined
      let manifestZipUrl: string | undefined
      let manifestUpdatedAt: string | undefined
      let description: AppStoreDescription = { name: appId }

      if (!isStringEntry) {
        const entryObject = entry as AppStoreManifestEntryObject
        const { descriptionUrl, zipUrl, updatedAt, ...rest } = entryObject
        if ('id' in rest) {
          delete (rest as Record<string, unknown>).id
        }
        manifestDescriptionUrl = descriptionUrl
        manifestZipUrl = zipUrl
        manifestUpdatedAt = updatedAt
        description = { ...description, ...rest }
      }

      const descriptionPath = `${APP_STORE_ROOT}/${appId}/description.json`
      const descriptionUrl = manifestDescriptionUrl || storage.getPublicUrl(descriptionPath).data.publicUrl
      if (descriptionUrl) {
        try {
          const response = await fetch(descriptionUrl, { cache: 'no-store' })
          if (response.ok) {
            description = { ...description, ...(await response.json()) }
          }
        } catch {
          // Keep fallback description if fetch fails
        }
      }

      const zipHint = resolveZipHint(description)
      let zipName: string | null = null
      let zipUrl: string | null = null

      if (manifestZipUrl) {
        if (isAbsoluteUrl(manifestZipUrl)) {
          zipUrl = manifestZipUrl
        } else {
          zipName = manifestZipUrl
        }
      } else if (zipHint) {
        if (isAbsoluteUrl(zipHint)) {
          zipUrl = zipHint
        } else {
          zipName = zipHint
        }
      } else {
        zipName = `${appId}.zip`
      }

      if (!zipUrl && zipName) {
        const zipPath = `${APP_STORE_ROOT}/${appId}/${zipName}`
        zipUrl = storage.getPublicUrl(zipPath).data.publicUrl
      }

      const displayName = description.title || description.name || appId

      return {
        id: appId,
        name: displayName,
        description,
        descriptionUrl,
        zipName,
        zipUrl,
        updatedAt: manifestUpdatedAt || null,
        source: 'first-party',
      } as AppStoreApp
    })
  )

  return apps
}

export async function fetchPublicAppStoreApps(): Promise<AppStoreApp[]> {
  const response =
    environment === 'electron'
      ? await localApi.get<{ success: boolean; apps?: PublicAppApiRecord[] }>('/app-store/community')
      : await publicApiCall<{ success: boolean; apps?: PublicAppApiRecord[] }>('/app-store/community', {
          method: 'GET',
        })

  const records = response.apps || []

  return records.map(record => {
    const description = (record.description || { name: record.app_id }) as AppStoreDescription
    const displayName = description.title || description.name || record.app_id
    return {
      id: record.app_id,
      name: displayName,
      description,
      descriptionUrl: record.description_url || null,
      zipName: null,
      zipUrl: record.zip_url || null,
      updatedAt: record.updated_at || record.created_at || null,
      source: 'community',
      containsExecutables: Boolean(record.contains_executables),
      uploader: {
        id: record.uploader_user_id || null,
        username: record.uploader?.username ?? null,
      },
    } as AppStoreApp
  })
}

export async function validateCommunityAppUpload(file: File): Promise<CommunityAppUploadValidation> {
  if (environment !== 'electron') {
    throw new Error('Community app uploads are only available in the desktop app.')
  }

  const buffer = await file.arrayBuffer()
  const response = await fetch(await buildLocalApiUrl('/app-store/validate-upload'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      'x-app-store-filename': file.name,
    },
    body: buffer,
  })

  const data = (await response.json()) as CommunityAppUploadValidation

  if (!response.ok || !data.success) {
    throw new Error(data.error || `Upload validation failed (${response.status})`)
  }

  return data
}

export async function uploadCommunityApp(file: File): Promise<AppStoreApp> {
  assertCloudAppStoreWriteEnabled()

  if (environment !== 'electron') {
    throw new Error('Community app uploads are only available in the desktop app.')
  }


  const buffer = await file.arrayBuffer()
  const response = await fetch(await buildLocalApiUrl('/app-store/community/upload'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      'x-app-store-filename': file.name,
    },
    body: buffer,
  })

  const data = (await response.json()) as { success: boolean; app?: PublicAppApiRecord; error?: string }

  if (!response.ok || !data.success || !data.app) {
    throw new Error(data.error || `Upload failed (${response.status})`)
  }

  const record = data.app
  const description = (record.description || { name: record.app_id }) as AppStoreDescription
  const displayName = description.title || description.name || record.app_id

  return {
    id: record.app_id,
    name: displayName,
    description,
    descriptionUrl: record.description_url || null,
    zipName: null,
    zipUrl: record.zip_url || null,
    updatedAt: record.updated_at || record.created_at || null,
    source: 'community',
    containsExecutables: Boolean(record.contains_executables),
    uploader: {
      id: record.uploader_user_id || null,
      username: record.uploader?.username ?? null,
    },
  } as AppStoreApp
}

export async function installAppFromStore(payload: {
  appId: string
  appName?: string
  zipUrl?: string | null
  mode?: 'install' | 'update'
}): Promise<AppStoreInstallResult> {
  if (environment !== 'electron') {
    throw new Error('App installs are only available in the desktop app.')
  }

  if (!payload.zipUrl) {
    throw new Error('No download URL available for this app.')
  }

  return await localApi.post<AppStoreInstallResult>('/app-store/install', payload)
}

export async function uninstallAppFromStore(payload: { appId: string }): Promise<AppStoreUninstallResult> {
  if (environment !== 'electron') {
    throw new Error('App uninstalls are only available in the desktop app.')
  }

  return await localApi.post<AppStoreUninstallResult>('/app-store/uninstall', payload)
}

export async function fetchInstalledCustomTools(): Promise<CustomToolDefinition[]> {
  if (environment !== 'electron') {
    return []
  }

  const response = await localApi.get<{ success: boolean; tools?: CustomToolDefinition[] }>('/custom-tools')
  return response.tools ?? []
}

export async function restartDesktopApp(): Promise<{ success: boolean; error?: string }> {
  if (environment !== 'electron') {
    return { success: false, error: 'Restart is only available in the desktop app.' }
  }

  return await localApi.post('/app/restart')
}
