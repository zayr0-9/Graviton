import { createAsyncThunk } from '@reduxjs/toolkit'
import { Project } from '../../../../../shared/types'
import { gwApi } from '../../utils/api'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import { RootState } from '../../store/store'

// Thin client: all project CRUD/reads go through the local /api/gw/* gateway.

// Fetch all projects (latest activity first)
export const fetchProjects = createAsyncThunk<Project[], void, { extra: ThunkExtraArgument }>(
  'projects/fetchProjects',
  async (_, { extra }) => {
    const { auth } = extra
    return await gwApi.get<Project[]>(`/projects?userId=${auth.userId}`)
  }
)

// Fetch project by ID
export const fetchProjectById = createAsyncThunk<
  Project,
  { id: number | string },
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
}

export const createProject = createAsyncThunk<Project, CreateProjectPayload, { extra: ThunkExtraArgument; state: RootState }>(
  'projects/createProject',
  async (payload, { extra }) => {
    const { auth } = extra
    const { conversation_id: _conversationId, ...restPayload } = payload
    return await gwApi.post<Project>('/projects', {
      userId: auth.userId,
      name: restPayload.name,
      context: restPayload.context || null,
      system_prompt: restPayload.system_prompt || null,
      cwd: restPayload.cwd || null,
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
}

export const updateProject = createAsyncThunk<Project, UpdateProjectPayload, { extra: ThunkExtraArgument; state: RootState }>(
  'projects/updateProject',
  async (payload) => {
    const { id, ...updateData } = payload
    return await gwApi.patch<Project>(`/projects/${id}`, {
      name: updateData.name,
      context: updateData.context ?? null,
      system_prompt: updateData.system_prompt ?? null,
      cwd: updateData.cwd ?? null,
    })
  }
)

// Delete project
export const deleteProject = createAsyncThunk<
  number | string,
  { id: number | string },
  { extra: ThunkExtraArgument; state: RootState }
>('projects/deleteProject', async ({ id: projectId }) => {
  await gwApi.delete(`/projects/${projectId}`)
  return projectId
})
