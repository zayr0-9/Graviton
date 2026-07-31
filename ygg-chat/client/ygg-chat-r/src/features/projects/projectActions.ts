import { createAsyncThunk } from '@reduxjs/toolkit'
import { Project, StorageMode } from '../../../../../shared/types'
import { isCommunityMode } from '../../config/runtimeMode'
import { gwApi, environment } from '../../utils/api'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import { RootState } from '../../store/store'

// Phase 5: thin client. All project CRUD/reads go through the /api/gw/* gateway,
// which owns the local-vs-cloud branch, the merge, and the cloud→SQLite mirror.

// Fetch all projects (gateway merges local + cloud, cloud-first, latest-activity desc)
export const fetchProjects = createAsyncThunk<Project[], void, { extra: ThunkExtraArgument }>(
  'projects/fetchProjects',
  async (_, { extra }) => {
    const { auth } = extra
    return await gwApi.get<Project[]>(`/projects?userId=${auth.userId}`)
  }
)

// Fetch project by ID (gateway routes by the entity's storage mode)
export const fetchProjectById = createAsyncThunk<
  Project,
  { id: number | string; storageMode?: StorageMode },
  { extra: ThunkExtraArgument; state: RootState }
>('projects/fetchProjectById', async ({ id: projectId }) => {
  return await gwApi.get<Project>(`/projects/${projectId}`)
})

// Create project
export interface CreateProjectPayload {
  name: string
  conversation_id?: number | string
  context?: string
  system_prompt?: string
  cwd?: string | null
  storageMode?: StorageMode
}

export const createProject = createAsyncThunk<Project, CreateProjectPayload, { extra: ThunkExtraArgument; state: RootState }>(
  'projects/createProject',
  async (payload, { extra }) => {
    const { auth } = extra
    const { storageMode, conversation_id: _conversationId, ...restPayload } = payload
    const isCommunity = environment === 'electron' && isCommunityMode
    const effectiveStorageMode = isCommunity ? 'local' : storageMode || 'cloud'

    // Canonical body; the gateway normalizes per storage leg + mirrors cloud creates.
    return await gwApi.post<Project>('/projects', {
      userId: auth.userId,
      name: restPayload.name,
      context: restPayload.context || null,
      system_prompt: restPayload.system_prompt || null,
      cwd: restPayload.cwd || null,
      storageMode: effectiveStorageMode,
    })
  }
)

// Update project
export interface UpdateProjectPayload {
  id: number | string
  name: string
  context?: string
  system_prompt?: string
  cwd?: string | null
  storage_mode?: StorageMode
}

export const updateProject = createAsyncThunk<Project, UpdateProjectPayload, { extra: ThunkExtraArgument; state: RootState }>(
  'projects/updateProject',
  async (payload) => {
    const { id, storage_mode: _storageMode, ...updateData } = payload
    // Canonical body; gateway forwards to local (with cwd) or cloud (cwd stripped).
    return await gwApi.patch<Project>(`/projects/${id}`, {
      name: updateData.name,
      context: updateData.context ?? null,
      system_prompt: updateData.system_prompt ?? null,
      cwd: updateData.cwd ?? null,
    })
  }
)

// Delete project (gateway routes by storage mode; cloud deletes propagate to SQLite)
export const deleteProject = createAsyncThunk<
  number | string,
  { id: number | string; storageMode?: StorageMode },
  { extra: ThunkExtraArgument; state: RootState }
>('projects/deleteProject', async ({ id: projectId }) => {
  await gwApi.delete(`/projects/${projectId}`)
  return projectId
})
