import { useQueryClient } from '@tanstack/react-query'
import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Project, ProjectWithLatestConversation } from '../../../../shared/types'
import { chatSliceActions } from '../features/chats'
import { createConversation } from '../features/conversations'
import type { Conversation } from '../features/conversations/conversationTypes'
import { createProject } from '../features/projects/projectActions'
import { setSelectedProject } from '../features/projects/projectSlice'
import { useAppDispatch } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import { useProjects, useRecentConversations } from '../hooks/useQueries'

const DEFAULT_PROJECT_NAME = 'Quick Chat'
const DEFAULT_CONVERSATION_TITLE = 'New Chat'

const sortProjectsByActivity = (projects: ProjectWithLatestConversation[]) => {
  return [...projects].sort((a, b) => {
    const activityA = a.latest_conversation_updated_at || a.updated_at || a.created_at
    const activityB = b.latest_conversation_updated_at || b.updated_at || b.created_at
    return new Date(activityB).getTime() - new Date(activityA).getTime()
  })
}

const upsertConversationInList = (
  previous: Conversation[] | undefined,
  conversation: Conversation
): Conversation[] => {
  const existingItems = previous || []
  return [conversation, ...existingItems.filter(item => String(item.id) !== String(conversation.id))]
}

const upsertProjectInList = (
  previous: ProjectWithLatestConversation[] | undefined,
  project: Project,
  latestConversationUpdatedAt: string | null = null
): ProjectWithLatestConversation[] => {
  const existingItems = previous || []
  const existingProject = existingItems.find(item => String(item.id) === String(project.id))
  const nextProject: ProjectWithLatestConversation = {
    ...existingProject,
    ...project,
    updated_at:
      latestConversationUpdatedAt ||
      project.updated_at ||
      existingProject?.updated_at ||
      project.created_at ||
      existingProject?.created_at ||
      new Date().toISOString(),
    latest_conversation_updated_at:
      latestConversationUpdatedAt ?? existingProject?.latest_conversation_updated_at ?? null,
  }

  return sortProjectsByActivity([
    nextProject,
    ...existingItems.filter(item => String(item.id) !== String(project.id)),
  ])
}

const HomepageRedirect: React.FC = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { userId, accessToken, loading: authLoading } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const redirectInFlightRef = useRef(false)

  const {
    data: allProjects = [],
    isLoading: projectsLoading,
    isRefetching: projectsRefetching,
  } = useProjects()
  const {
    data: recentConversations = [],
    isLoading: conversationsLoading,
    isRefetching: conversationsRefetching,
  } = useRecentConversations(10)

  useEffect(() => {
    if (redirectInFlightRef.current) return
    if (authLoading) return
    if (!userId || !accessToken) return
    if (projectsLoading || projectsRefetching || conversationsLoading || conversationsRefetching) return

    redirectInFlightRef.current = true

    const redirectToChat = async () => {
      try {
        setError(null)

        const latestConversation = recentConversations.find(conversation => conversation.project_id)
        if (latestConversation?.id && latestConversation.project_id) {
          const matchingProject = allProjects.find(project => String(project.id) === String(latestConversation.project_id))
          if (matchingProject) {
            dispatch(setSelectedProject(matchingProject))
          }

          dispatch(chatSliceActions.conversationSet(latestConversation.id))
          navigate(`/chat/${latestConversation.project_id}/${latestConversation.id}`, {
            replace: true,
            state: latestConversation.storage_mode ? { storageMode: latestConversation.storage_mode } : undefined,
          })
          return
        }

        let targetProject: ProjectWithLatestConversation | null = allProjects[0] ?? null
        if (!targetProject) {
          const createdProject = await dispatch(
            createProject({
              name: DEFAULT_PROJECT_NAME,
            })
          ).unwrap()

          targetProject = {
            ...createdProject,
            latest_conversation_updated_at: null,
          }

          queryClient.setQueryData<ProjectWithLatestConversation[]>(['projects', userId], previous =>
            upsertProjectInList(previous, createdProject)
          )
        }

        dispatch(setSelectedProject(targetProject))

        const targetStorageMode = targetProject.storage_mode || 'cloud'
        const conversation = await dispatch(
          createConversation({
            title: DEFAULT_CONVERSATION_TITLE,
            projectId: String(targetProject.id),
            systemPrompt: null,
            conversationContext: null,
            storageMode: targetStorageMode,
          })
        ).unwrap()

        const activityTimestamp = conversation.updated_at || conversation.created_at || new Date().toISOString()

        queryClient.setQueryData<ProjectWithLatestConversation[]>(['projects', userId], previous =>
          upsertProjectInList(previous, targetProject as Project, activityTimestamp)
        )
        queryClient.setQueryData<Conversation[]>(['conversations'], previous =>
          upsertConversationInList(previous, conversation)
        )
        queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, previous =>
          upsertConversationInList(previous, conversation)
        )
        queryClient.setQueryData<Conversation[]>(['conversations', 'project', targetProject.id], previous =>
          upsertConversationInList(previous, conversation)
        )

        dispatch(chatSliceActions.conversationSet(conversation.id))

        queryClient.invalidateQueries({ queryKey: ['projects', userId] })
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        queryClient.invalidateQueries({ queryKey: ['conversations', 'recent'] })
        queryClient.invalidateQueries({ queryKey: ['conversations', 'project', targetProject.id] })

        navigate(`/chat/${targetProject.id}/${conversation.id}`, {
          replace: true,
          state: { storageMode: conversation.storage_mode || targetStorageMode },
        })
      } catch (bootstrapError) {
        console.error('[HomepageRedirect] Failed to bootstrap startup chat:', bootstrapError)
        setError(bootstrapError instanceof Error ? bootstrapError.message : 'Failed to open chat')
        redirectInFlightRef.current = false
      }
    }

    void redirectToChat()
  }, [
    accessToken,
    allProjects,
    authLoading,
    conversationsLoading,
    conversationsRefetching,
    dispatch,
    navigate,
    projectsLoading,
    projectsRefetching,
    queryClient,
    recentConversations,
    userId,
  ])

  return (
    <div className='min-h-screen flex items-center justify-center px-6'>
      <div className='text-center space-y-3'>
        <div className='text-lg font-medium dark:text-neutral-100'>Opening your chat…</div>
        <div className='text-sm text-neutral-600 dark:text-neutral-400'>Preparing your default project and conversation.</div>
        {error ? <div className='text-sm text-red-500 dark:text-red-400'>{error}</div> : null}
      </div>
    </div>
  )
}

export default HomepageRedirect
