import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mobileApi } from './api'
import { Composer } from './components/Composer'
import { FilePathPickerModal } from './components/FilePathPickerModal'
import { MessageList } from './components/MessageList'
import { MessageTreeDrawer } from './components/MessageTreeDrawer'
import { MobileHeader } from './components/MobileHeader'
import { ProjectConversationTree } from './components/ProjectConversationTree'
import { Button } from './components/ui'
import { buildRenderItemsForMessage } from './messageParser'
import type {
  HeadlessSseEvent,
  LocalUserProfile,
  MobileConversation,
  MobileCustomTool,
  MobileInferenceTool,
  MobileMessage,
  MobileMessageTreeNode,
  MobileProject,
  MobileProviderModelInfo,
  MobileProviderName,
  ToolCallLike,
  ToolResultLike,
} from './types'

type StreamingState = {
  text: string
  reasoning: string
  toolCallsById: Record<string, ToolCallLike>
  toolOrder: string[]
  toolResults: ToolResultLike[]
}

const createStreamingState = (): StreamingState => ({
  text: '',
  reasoning: '',
  toolCallsById: {},
  toolOrder: [],
  toolResults: [],
})

const projectKey = (projectId: string | null | undefined) => projectId || '__none__'

const MOBILE_LAST_USER_STORAGE_KEY = 'mobile:lastUserId'
const MOBILE_LAST_PROVIDER_STORAGE_KEY = 'mobile:lastProvider'
const mobileLastConversationStorageKey = (userId: string) => `mobile:lastConversationId:${userId}`
const DEFAULT_PROVIDER: MobileProviderName = 'openaichatgpt'

const readStorageValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(key)
    return value && value.trim().length > 0 ? value : null
  } catch {
    return null
  }
}

const writeStorageValue = (key: string, value: string | null) => {
  if (typeof window === 'undefined') return
  try {
    if (!value || value.trim().length === 0) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    // ignore storage failures
  }
}

const normalizeCwd = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeProviderName = (value: string | null | undefined): MobileProviderName => {
  if (value === 'openrouter' || value === 'lmstudio' || value === 'openaichatgpt') return value
  return DEFAULT_PROVIDER
}

const getDefaultModelForProvider = (provider: MobileProviderName, providers: MobileProviderModelInfo[]): string => {
  const match = providers.find(item => item.name === provider)
  return match?.models?.[0] || ''
}

const makeStreamingMessage = (state: StreamingState | null): MobileMessage | null => {
  if (!state) return null

  const hasContent =
    state.text.trim().length > 0 ||
    state.reasoning.trim().length > 0 ||
    state.toolOrder.length > 0 ||
    state.toolResults.length > 0

  if (!hasContent) return null

  let index = 0
  const contentBlocks: any[] = []

  if (state.reasoning.trim()) {
    contentBlocks.push({ type: 'thinking', index: index++, content: state.reasoning })
  }

  if (state.text.trim()) {
    contentBlocks.push({ type: 'text', index: index++, content: state.text })
  }

  state.toolOrder.forEach(toolId => {
    const toolCall = state.toolCallsById[toolId]
    if (!toolCall) return

    contentBlocks.push({
      type: 'tool_use',
      index: index++,
      id: toolId,
      name: toolCall.name || 'tool',
      input: toolCall.arguments || {},
    })

    state.toolResults
      .filter(result => result.tool_use_id === toolId)
      .forEach(result => {
        contentBlocks.push({
          type: 'tool_result',
          index: index++,
          tool_use_id: toolId,
          content: result.content,
          is_error: Boolean(result.is_error),
        })
      })
  })

  return {
    id: 'streaming-assistant',
    role: 'assistant',
    content: state.text,
    content_blocks: contentBlocks,
  }
}

const parseChildrenIds = (value: MobileMessage['children_ids']): string[] => {
  if (Array.isArray(value)) return value.map(item => String(item))
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(item => String(item)) : []
    } catch {
      return []
    }
  }
  return []
}

const compareMessageIdStrings = (left: string, right: string): number => {
  const leftNum = Number(left)
  const rightNum = Number(right)

  const leftIsNumeric = Number.isFinite(leftNum)
  const rightIsNumeric = Number.isFinite(rightNum)

  if (leftIsNumeric && rightIsNumeric) return leftNum - rightNum
  return left.localeCompare(right)
}

const resolveLatestLeafMessageId = (items: MobileMessage[]): string | null => {
  if (!items.length) return null

  const leafCandidates = items.filter(message => parseChildrenIds(message.children_ids).length === 0)
  const candidates = leafCandidates.length > 0 ? leafCandidates : items

  const sorted = [...candidates].sort((a, b) => {
    const aTs = a.created_at ? new Date(a.created_at).getTime() : 0
    const bTs = b.created_at ? new Date(b.created_at).getTime() : 0
    return aTs - bTs
  })

  const selected = sorted[sorted.length - 1]
  return selected ? String(selected.id) : null
}

const buildPathToMessageId = (
  items: MobileMessage[],
  targetMessageId: string | null | undefined,
  preferredPathIds: string[] = []
): string[] => {
  if (!targetMessageId) return []

  const byId = new Map(items.map(message => [String(message.id), message]))
  const parentToChildren = new Map<string, string[]>()

  items.forEach(message => {
    const parentId = message.parent_id ? String(message.parent_id) : null
    if (!parentId) return

    const childId = String(message.id)
    const children = parentToChildren.get(parentId)
    if (children) {
      children.push(childId)
    } else {
      parentToChildren.set(parentId, [childId])
    }
  })

  parentToChildren.forEach(children => children.sort(compareMessageIdStrings))

  const path: string[] = []
  const visited = new Set<string>()
  let cursorId: string | null = String(targetMessageId)

  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId)
    const message = byId.get(cursorId)
    if (!message) break

    path.push(String(message.id))
    cursorId = message.parent_id ? String(message.parent_id) : null
  }

  path.reverse()

  if (!path.length) return []

  const visitedDesc = new Set(path)
  const preferredSet = new Set(preferredPathIds.map(id => String(id)))
  let descCursor = path[path.length - 1]

  while (true) {
    const children = parentToChildren.get(descCursor) || []
    if (children.length === 0) break

    const preferredChildId = children.find(childId => preferredSet.has(String(childId)) && !visitedDesc.has(childId))
    const nextChildId = preferredChildId || children.find(childId => !visitedDesc.has(childId))
    if (!nextChildId) break

    path.push(nextChildId)
    visitedDesc.add(nextChildId)
    descCursor = nextChildId
  }

  return path
}

const mapPathToMessages = (items: MobileMessage[], pathIds: string[]): MobileMessage[] => {
  if (!pathIds.length) return []
  const byId = new Map(items.map(message => [String(message.id), message]))
  return pathIds
    .map(id => byId.get(String(id)))
    .filter((message): message is MobileMessage => Boolean(message))
}

const filterEmptyAssistantNodes = (tree: MobileMessageTreeNode | null): MobileMessageTreeNode | null => {
  if (!tree) return null

  const filterNode = (node: MobileMessageTreeNode, isSyntheticRoot: boolean): MobileMessageTreeNode[] => {
    const children = Array.isArray(node.children) ? node.children : []
    const filteredChildren = children.flatMap(child => filterNode(child, false))

    const normalizedNode: MobileMessageTreeNode = {
      ...node,
      children: filteredChildren,
    }

    if (isSyntheticRoot) {
      return [normalizedNode]
    }

    const isEmptyAssistant =
      String(normalizedNode.sender || '').toLowerCase() === 'assistant' &&
      String(normalizedNode.message || '').trim().length === 0

    if (isEmptyAssistant) {
      return filteredChildren
    }

    return [normalizedNode]
  }

  const isSyntheticRoot = String(tree.id) === 'root'
  const filtered = filterNode(tree, isSyntheticRoot)

  if (filtered.length === 0) return null
  if (filtered.length === 1) return filtered[0]

  return {
    id: 'root',
    message: 'Conversation',
    sender: 'assistant',
    children: filtered,
  }
}

export const App: React.FC = () => {
  const [selectedProvider, setSelectedProvider] = useState<MobileProviderName>(() =>
    normalizeProviderName(readStorageValue(MOBILE_LAST_PROVIDER_STORAGE_KEY))
  )
  const [providerModels, setProviderModels] = useState<MobileProviderModelInfo[]>([])
  const [modelName, setModelName] = useState('gpt-5.4')
  const [statusText, setStatusText] = useState('Loading…')

  const [users, setUsers] = useState<LocalUserProfile[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string | null>(() => readStorageValue(MOBILE_LAST_USER_STORAGE_KEY))

  const [projects, setProjects] = useState<MobileProject[]>([])
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<string[]>([])
  const [loadingProjectKeys, setLoadingProjectKeys] = useState<string[]>([])
  const [conversationsByProjectKey, setConversationsByProjectKey] = useState<Record<string, MobileConversation[]>>({})

  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [allMessages, setAllMessages] = useState<MobileMessage[]>([])
  const [messages, setMessages] = useState<MobileMessage[]>([])
  const [messageTree, setMessageTree] = useState<MobileMessageTreeNode | null>(null)
  const [currentPathMessageIds, setCurrentPathMessageIds] = useState<string[]>([])
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null)
  const [isTreeDrawerOpen, setIsTreeDrawerOpen] = useState(false)
  const [isProjectsModalOpen, setIsProjectsModalOpen] = useState(false)
  const [isPathPickerOpen, setIsPathPickerOpen] = useState(false)
  const [hideEmptyAssistantMessages, setHideEmptyAssistantMessages] = useState(true)

  const [draft, setDraft] = useState('')
  const [conversationSystemPromptInput, setConversationSystemPromptInput] = useState('')
  const [conversationContextInput, setConversationContextInput] = useState('')
  const [conversationCwdInput, setConversationCwdInput] = useState('')
  const [savingConversationSettings, setSavingConversationSettings] = useState(false)
  const [branchSourceMessage, setBranchSourceMessage] = useState<MobileMessage | null>(null)
  const [sending, setSending] = useState(false)
  const [streamingState, setStreamingState] = useState<StreamingState | null>(null)
  const [composerBlockModal, setComposerBlockModal] = useState<{ title: string; message: string } | null>(null)
  const [openAiConnected, setOpenAiConnected] = useState(false)
  const [openRouterConnected, setOpenRouterConnected] = useState(false)
  const [openAiBusy, setOpenAiBusy] = useState(false)
  const [pendingOpenAiState, setPendingOpenAiState] = useState<string | null>(null)

  const [customTools, setCustomTools] = useState<MobileCustomTool[]>([])
  const [customToolsLoading, setCustomToolsLoading] = useState(false)
  const [customToolBusyNames, setCustomToolBusyNames] = useState<string[]>([])
  const [inferenceTools, setInferenceTools] = useState<MobileInferenceTool[]>([])

  const lastStreamCompleteMessageIdRef = useRef<string | null>(null)
  const currentPathIdsRef = useRef<string[]>([])

  const streamingMessage = useMemo(() => makeStreamingMessage(streamingState), [streamingState])

  const displayedMessages = useMemo(() => {
    if (!hideEmptyAssistantMessages) return messages
    return messages.filter(message => !(message.role === 'assistant' && buildRenderItemsForMessage(message).length === 0))
  }, [messages, hideEmptyAssistantMessages])

  const treeForDrawer = useMemo(() => {
    if (!hideEmptyAssistantMessages) return messageTree
    return filterEmptyAssistantNodes(messageTree)
  }, [messageTree, hideEmptyAssistantMessages])

  const activeConversation = useMemo(() => {
    if (!activeConversationId) return null

    for (const bucket of Object.values(conversationsByProjectKey)) {
      const found = bucket.find(conversation => conversation.id === activeConversationId)
      if (found) return found
    }

    return null
  }, [activeConversationId, conversationsByProjectKey])

  const projectById = useMemo(() => {
    const next = new Map<string, MobileProject>()
    projects.forEach(project => {
      next.set(project.id, project)
    })
    return next
  }, [projects])

  const activeProject = useMemo(() => {
    const projectId = activeConversation?.project_id || null
    return projectId ? projectById.get(projectId) || null : null
  }, [activeConversation?.project_id, projectById])

  const activeProjectCwd = useMemo(() => {
    const conversationCwd = normalizeCwd(activeConversation?.cwd)
    if (conversationCwd) return conversationCwd

    const projectId = activeConversation?.project_id || null
    const projectCwd = projectId ? normalizeCwd(projectById.get(projectId)?.cwd) : null
    if (projectCwd) return projectCwd

    return null
  }, [activeConversation, projectById])

  const availableModelOptions = useMemo(() => {
    const models = providerModels.find(provider => provider.name === selectedProvider)?.models || []
    return models.length > 0 ? models : [modelName]
  }, [providerModels, selectedProvider, modelName])

  const selectedProviderRequiresAuth = selectedProvider === 'openaichatgpt' || selectedProvider === 'openrouter'
  const selectedProviderAuthenticated =
    selectedProvider === 'openaichatgpt' ? openAiConnected : selectedProvider === 'openrouter' ? openRouterConnected : true

  const composerDisabledReason = useMemo(() => {
    if (!selectedUserId) {
      return {
        title: 'No user profile selected',
        message: 'Please select a user profile first. Open settings in the header and choose a profile.',
      }
    }

    if (!activeConversationId) {
      return {
        title: 'No active conversation',
        message:
          'Your conversation is not ready yet. Open Projects & Conversations and select one, or create a new conversation.',
      }
    }

    if (selectedProviderRequiresAuth && !selectedProviderAuthenticated) {
      const providerLabel = selectedProvider === 'openaichatgpt' ? 'OpenAI' : 'OpenRouter'
      return {
        title: `${providerLabel} is not connected`,
        message: `This provider requires authentication. Open Settings and sign in to ${providerLabel}, then try again.`,
      }
    }

    return null
  }, [
    selectedUserId,
    activeConversationId,
    selectedProviderRequiresAuth,
    selectedProviderAuthenticated,
    selectedProvider,
  ])

  const handleComposerDisabledInteract = useCallback(() => {
    if (!composerDisabledReason) return
    setComposerBlockModal(composerDisabledReason)
  }, [composerDisabledReason])

  useEffect(() => {
    if (!composerDisabledReason && composerBlockModal) {
      setComposerBlockModal(null)
    }
  }, [composerDisabledReason, composerBlockModal])

  useEffect(() => {
    setConversationSystemPromptInput(activeProject?.system_prompt || activeConversation?.system_prompt || '')
    setConversationContextInput(activeProject?.context || activeConversation?.conversation_context || '')

    const currentConversationCwd = normalizeCwd(activeConversation?.cwd)
    setConversationCwdInput(currentConversationCwd || '')
  }, [
    activeConversationId,
    activeConversation?.conversation_context,
    activeConversation?.cwd,
    activeConversation?.system_prompt,
    activeProject?.context,
    activeProject?.system_prompt,
  ])

  const loadUsers = async () => {
    const listed = await mobileApi.listUsers()
    setUsers(listed)

    if (listed.length === 0) {
      setSelectedUserId(null)
      return
    }

    const storedUserId = readStorageValue(MOBILE_LAST_USER_STORAGE_KEY)

    setSelectedUserId(current => {
      const preferred = current || storedUserId
      const exists = preferred ? listed.some(user => user.id === preferred) : false
      return exists && preferred ? preferred : listed[0].id
    })
  }

  const loadProjects = async (userId: string) => {
    const listed = await mobileApi.listProjects(userId)
    setProjects(listed)
  }

  const loadConversationsForProject = async (userId: string, projectId: string | null) => {
    const key = projectKey(projectId)

    setLoadingProjectKeys(previous => (previous.includes(key) ? previous : [...previous, key]))

    try {
      const listed = await mobileApi.listConversations(userId, projectId)
      setConversationsByProjectKey(previous => ({ ...previous, [key]: listed }))

      setActiveConversationId(current => {
        if (current) return current
        return listed[0]?.id || null
      })
    } finally {
      setLoadingProjectKeys(previous => previous.filter(value => value !== key))
    }
  }

  const toggleProject = async (projectId: string | null) => {
    if (!selectedUserId) return

    const key = projectKey(projectId)
    const willExpand = !expandedProjectKeys.includes(key)

    if (willExpand && !conversationsByProjectKey[key]) {
      try {
        await loadConversationsForProject(selectedUserId, projectId)
      } catch (error) {
        setStatusText(error instanceof Error ? error.message : String(error))
      }
    }

    setExpandedProjectKeys(previous =>
      willExpand ? [...previous, key] : previous.filter(value => value !== key)
    )
  }

  const selectPathFromMessageId = useCallback((sourceMessages: MobileMessage[], targetMessageId: string | null) => {
    if (!sourceMessages.length) {
      setCurrentPathMessageIds([])
      setMessages([])
      return
    }

    const pathIds = buildPathToMessageId(sourceMessages, targetMessageId, currentPathIdsRef.current)
    if (!pathIds.length) {
      setCurrentPathMessageIds([])
      setMessages(sourceMessages)
      return
    }

    setCurrentPathMessageIds(pathIds)
    setMessages(mapPathToMessages(sourceMessages, pathIds))
  }, [])

  const selectLatestBranch = useCallback(
    (sourceMessages: MobileMessage[]) => {
      const latestLeafId = resolveLatestLeafMessageId(sourceMessages)
      selectPathFromMessageId(sourceMessages, latestLeafId)
    },
    [selectPathFromMessageId]
  )

  const loadConversationTree = useCallback(
    async (
      conversationId: string,
      options?: {
        preferredMessageId?: string | null
        preserveCurrentPath?: boolean
      }
    ) => {
      const payload = await mobileApi.getConversationMessageTree(conversationId)
      const listed = Array.isArray(payload.messages) ? payload.messages : []

      setAllMessages(listed)
      setMessageTree(payload.tree || null)

      const preferredMessageId = options?.preferredMessageId || null
      const preserveCurrentPath = Boolean(options?.preserveCurrentPath)

      if (preferredMessageId) {
        const found = listed.some(message => String(message.id) === String(preferredMessageId))
        if (found) {
          selectPathFromMessageId(listed, String(preferredMessageId))
          return
        }
      }

      const currentPathIds = currentPathIdsRef.current
      if (preserveCurrentPath && currentPathIds.length > 0) {
        const currentTipId = currentPathIds[currentPathIds.length - 1]
        const found = listed.some(message => String(message.id) === String(currentTipId))
        if (found) {
          selectPathFromMessageId(listed, String(currentTipId))
          return
        }
      }

      selectLatestBranch(listed)
    },
    [selectLatestBranch, selectPathFromMessageId]
  )

  const refreshOpenAiStatus = async (userId: string) => {
    try {
      const status = await mobileApi.getOpenAiTokenStatus(userId)
      setOpenAiConnected(Boolean(status.hasToken))
    } catch {
      setOpenAiConnected(false)
    }
  }

  const refreshOpenRouterStatus = async (userId: string) => {
    try {
      const status = await mobileApi.getOpenRouterTokenStatus(userId)
      setOpenRouterConnected(Boolean(status.hasToken))
    } catch {
      setOpenRouterConnected(false)
    }
  }

  const loadCustomTools = async () => {
    setCustomToolsLoading(true)
    try {
      const listed = await mobileApi.listCustomTools()
      setCustomTools(listed)
    } finally {
      setCustomToolsLoading(false)
    }
  }

  const loadInferenceTools = async () => {
    try {
      const listed = await mobileApi.listInferenceTools()
      setInferenceTools(listed)
    } catch {
      setInferenceTools([])
    }
  }

  const handleToggleCustomTool = async (toolName: string, enabled: boolean) => {
    setCustomToolBusyNames(previous => (previous.includes(toolName) ? previous : [...previous, toolName]))

    try {
      await mobileApi.setCustomToolEnabled(toolName, enabled)
      setCustomTools(previous => previous.map(tool => (tool.name === toolName ? { ...tool, enabled } : tool)))
      await loadInferenceTools()
      setStatusText(`${enabled ? 'Enabled' : 'Disabled'} tool: ${toolName}`)
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    } finally {
      setCustomToolBusyNames(previous => previous.filter(value => value !== toolName))
    }
  }

  const handleOpenAiLoginStart = async () => {
    if (!selectedUserId || openAiBusy) {
      if (!selectedUserId) setStatusText('Select a user profile first')
      return
    }

    setOpenAiBusy(true)
    try {
      const flow = await mobileApi.startOpenAiOAuth()
      setPendingOpenAiState(flow.state)
      setStatusText('OpenAI sign-in opened. Complete login in browser, then tap Complete sign-in.')
      window.open(flow.authUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    } finally {
      setOpenAiBusy(false)
    }
  }

  const handleOpenAiLoginComplete = async () => {
    if (!selectedUserId || openAiBusy) {
      if (!selectedUserId) setStatusText('Select a user profile first')
      return
    }
    if (!pendingOpenAiState) {
      setStatusText('Start OpenAI sign-in first')
      return
    }

    setOpenAiBusy(true)
    try {
      const result = await mobileApi.completeOpenAiOAuth(pendingOpenAiState)
      if (result.pending) {
        setStatusText('OAuth still pending. Finish browser sign-in and try Complete sign-in again.')
        return
      }

      if (!result.accessToken || !result.refreshToken || !result.accountId) {
        throw new Error('OAuth completed without required token fields')
      }

      await mobileApi.storeOpenAiToken({
        userId: selectedUserId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        accountId: result.accountId,
      })

      setPendingOpenAiState(null)
      setOpenAiConnected(true)
      setStatusText('OpenAI connected')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    } finally {
      setOpenAiBusy(false)
    }
  }

  const handleOpenAiLogout = async () => {
    if (!selectedUserId || openAiBusy) {
      if (!selectedUserId) setStatusText('Select a user profile first')
      return
    }

    setOpenAiBusy(true)
    try {
      await mobileApi.clearOpenAiToken(selectedUserId)
      setPendingOpenAiState(null)
      setOpenAiConnected(false)
      setStatusText('OpenAI disconnected')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    } finally {
      setOpenAiBusy(false)
    }
  }

  const handleCreateProject = async () => {
    if (!selectedUserId) return

    const name = window.prompt('Project name', 'Mobile Project')?.trim()
    if (!name) return

    try {
      const created = await mobileApi.createProject({ userId: selectedUserId, name })
      setProjects(previous => [created, ...previous])
      setStatusText(`Created project: ${created.name}`)
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    }
  }

  const handleCreateConversation = async (projectId: string | null) => {
    if (!selectedUserId) return

    const title = window.prompt('Conversation title', 'New Conversation')?.trim() || 'New Conversation'
    const projectCwd = projectId ? normalizeCwd(projectById.get(projectId)?.cwd) : null

    try {
      const created = await mobileApi.createConversation({
        userId: selectedUserId,
        projectId,
        title,
        cwd: projectCwd,
      })

      const key = projectKey(projectId)
      setConversationsByProjectKey(previous => {
        const bucket = previous[key] || []
        return {
          ...previous,
          [key]: [created, ...bucket],
        }
      })

      setExpandedProjectKeys(previous => (previous.includes(key) ? previous : [...previous, key]))
      setActiveConversationId(created.id)
      setStatusText(`Created conversation: ${created.title}`)
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSaveConversationSettings = async () => {
    if (!activeConversationId) {
      setStatusText('Select or create a conversation first')
      return
    }

    if (savingConversationSettings) return

    const normalizedCwd = normalizeCwd(conversationCwdInput)
    const normalizedSystemPrompt = conversationSystemPromptInput.trim() || null
    const normalizedConversationContext = conversationContextInput.trim() || null

    setSavingConversationSettings(true)
    try {
      const updatedConversation = await mobileApi.updateConversation(activeConversationId, { cwd: normalizedCwd })

      setConversationsByProjectKey(previous => {
        const next: Record<string, MobileConversation[]> = {}
        Object.entries(previous).forEach(([key, bucket]) => {
          next[key] = bucket.map(conversation =>
            conversation.id === updatedConversation.id ? { ...conversation, ...updatedConversation } : conversation
          )
        })
        return next
      })

      if (activeProject?.id) {
        const updatedProject = await mobileApi.updateProject(activeProject.id, {
          system_prompt: normalizedSystemPrompt,
          context: normalizedConversationContext,
        })

        setProjects(previous =>
          previous.map(project => (project.id === updatedProject.id ? { ...project, ...updatedProject } : project))
        )

        setConversationSystemPromptInput(updatedProject.system_prompt || '')
        setConversationContextInput(updatedProject.context || '')
      } else {
        const updatedConversationWithPrompt = await mobileApi.updateConversation(activeConversationId, {
          system_prompt: normalizedSystemPrompt,
          conversation_context: normalizedConversationContext,
        })

        setConversationsByProjectKey(previous => {
          const next: Record<string, MobileConversation[]> = {}
          Object.entries(previous).forEach(([key, bucket]) => {
            next[key] = bucket.map(conversation =>
              conversation.id === updatedConversationWithPrompt.id
                ? { ...conversation, ...updatedConversationWithPrompt }
                : conversation
            )
          })
          return next
        })

        setConversationSystemPromptInput(updatedConversationWithPrompt.system_prompt || '')
        setConversationContextInput(updatedConversationWithPrompt.conversation_context || '')
      }

      setConversationCwdInput(normalizeCwd(updatedConversation.cwd) || '')
      setStatusText(activeProject?.id ? 'Saved project prompt/context and conversation cwd' : 'Saved conversation settings')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingConversationSettings(false)
    }
  }

  const handleBranchUserMessage = (message: MobileMessage) => {
    if (message.role !== 'user') return
    setBranchSourceMessage(message)
    setDraft(typeof message.content === 'string' ? message.content : '')
    setStatusText('Branch mode: rewrite the selected prompt, then tap Send Branch')
  }

  const handleCancelBranch = () => {
    setBranchSourceMessage(null)
    setStatusText('Ready')
  }

  const handleDeleteUserMessage = async (message: MobileMessage) => {
    if (sending) return
    if (message.role !== 'user') return

    const confirmed = window.confirm('Delete this message? This may affect branch history.')
    if (!confirmed) return

    try {
      await mobileApi.deleteMessage(message.id)
      if (branchSourceMessage?.id === message.id) {
        setBranchSourceMessage(null)
      }
      if (activeConversationId) {
        await loadConversationTree(activeConversationId, {
          preferredMessageId: message.parent_id ? String(message.parent_id) : null,
          preserveCurrentPath: true,
        })
      }
      setStatusText('Message deleted')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSelectTreeNode = (messageId: string) => {
    if (!messageId) return
    const exists = allMessages.some(message => String(message.id) === String(messageId))
    if (!exists) return

    const normalizedId = String(messageId)
    selectPathFromMessageId(allMessages, normalizedId)
    setScrollToMessageId(normalizedId)
    setBranchSourceMessage(null)
    setStatusText(`Switched branch at message ${normalizedId.slice(0, 8)}…`)
  }

  const handleInsertPathIntoDraft = (insertPath: string) => {
    const nextPath = String(insertPath || '').trim()
    if (!nextPath) return

    setDraft(previous => {
      const trimmed = previous.trimEnd()
      if (!trimmed) return nextPath
      return `${trimmed}\n${nextPath}`
    })

    setStatusText(`Inserted path: ${nextPath}`)
  }

  useEffect(() => {
    currentPathIdsRef.current = currentPathMessageIds
  }, [currentPathMessageIds])

  useEffect(() => {
    writeStorageValue(MOBILE_LAST_USER_STORAGE_KEY, selectedUserId)
  }, [selectedUserId])

  useEffect(() => {
    writeStorageValue(MOBILE_LAST_PROVIDER_STORAGE_KEY, selectedProvider)
  }, [selectedProvider])

  useEffect(() => {
    const models = providerModels.find(provider => provider.name === selectedProvider)?.models || []
    if (models.length === 0) return
    if (models.includes(modelName)) return
    setModelName(models[0])
  }, [providerModels, selectedProvider, modelName])

  useEffect(() => {
    if (!selectedUserId) return
    writeStorageValue(mobileLastConversationStorageKey(selectedUserId), activeConversationId)
  }, [selectedUserId, activeConversationId])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        setStatusText('Checking capabilities…')
        await mobileApi.getCapabilities()
        if (cancelled) return

        const listedProviderModels = await mobileApi.getProviderModels()
        if (cancelled) return
        setProviderModels(listedProviderModels)
        const preferredProvider = normalizeProviderName(readStorageValue(MOBILE_LAST_PROVIDER_STORAGE_KEY))
        const preferredModel = getDefaultModelForProvider(preferredProvider, listedProviderModels)
        if (preferredModel) {
          setSelectedProvider(preferredProvider)
          setModelName(current => (listedProviderModels.some(provider => provider.name === preferredProvider && provider.models.includes(current)) ? current : preferredModel))
        }

        setStatusText('Loading user profiles…')
        await loadUsers()
        if (cancelled) return

        await loadCustomTools()
        if (cancelled) return

        await loadInferenceTools()
        if (cancelled) return

        setStatusText('Ready')
      } catch (error) {
        if (cancelled) return
        setStatusText(error instanceof Error ? error.message : String(error))
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedUserId) {
      setProjects([])
      setInferenceTools([])
      setConversationsByProjectKey({})
      setExpandedProjectKeys([])
      setActiveConversationId(null)
      setAllMessages([])
      setMessages([])
      setMessageTree(null)
      setCurrentPathMessageIds([])
      setScrollToMessageId(null)
      setIsTreeDrawerOpen(false)
      setIsPathPickerOpen(false)
      setBranchSourceMessage(null)
      setOpenAiConnected(false)
      setOpenRouterConnected(false)
      setPendingOpenAiState(null)
      setConversationSystemPromptInput('')
      setConversationContextInput('')
      setConversationCwdInput('')
      return
    }

    let cancelled = false

    const run = async () => {
      try {
        setStatusText('Loading projects…')
        await loadProjects(selectedUserId)
        if (cancelled) return

        await refreshOpenAiStatus(selectedUserId)
        if (cancelled) return

        await refreshOpenRouterStatus(selectedUserId)
        if (cancelled) return

        const listedProviderModels = await mobileApi.getProviderModels(selectedUserId)
        if (cancelled) return
        setProviderModels(listedProviderModels)

        await loadInferenceTools()
        if (cancelled) return

        setConversationsByProjectKey({})
        setExpandedProjectKeys([])
        setActiveConversationId(null)
        setAllMessages([])
        setMessages([])
        setMessageTree(null)
        setCurrentPathMessageIds([])
        setScrollToMessageId(null)
        setIsTreeDrawerOpen(false)
        setBranchSourceMessage(null)

        const savedConversationId = readStorageValue(mobileLastConversationStorageKey(selectedUserId))
        let restoredFromSavedConversation = false

        if (savedConversationId) {
          try {
            const savedConversation = await mobileApi.getConversation(savedConversationId)
            if (cancelled) return

            if (savedConversation && savedConversation.user_id === selectedUserId) {
              const savedProjectId = savedConversation.project_id ? String(savedConversation.project_id) : null
              const savedKey = projectKey(savedProjectId)

              await loadConversationsForProject(selectedUserId, savedProjectId)
              if (cancelled) return

              setExpandedProjectKeys([savedKey])
              setActiveConversationId(savedConversationId)
              restoredFromSavedConversation = true
            }
          } catch {
            // fall back to default no-project bucket
          }
        }

        if (!restoredFromSavedConversation) {
          const latestConversation = await mobileApi.getLatestConversation(selectedUserId)
          if (cancelled) return

          if (latestConversation) {
            const latestProjectId = latestConversation.project_id ? String(latestConversation.project_id) : null
            const latestKey = projectKey(latestProjectId)

            await loadConversationsForProject(selectedUserId, latestProjectId)
            if (cancelled) return

            setExpandedProjectKeys([latestKey])
            setActiveConversationId(String(latestConversation.id))
          } else {
            await loadConversationsForProject(selectedUserId, null)
            if (cancelled) return
            setExpandedProjectKeys([projectKey(null)])
          }
        }

        setStatusText('Ready')
      } catch (error) {
        if (cancelled) return
        setStatusText(error instanceof Error ? error.message : String(error))
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [selectedUserId])

  useEffect(() => {
    if (activeConversationId) return

    setAllMessages([])
    setMessages([])
    setMessageTree(null)
    setCurrentPathMessageIds([])
    setScrollToMessageId(null)
    setBranchSourceMessage(null)
  }, [activeConversationId])

  useEffect(() => {
    if (!activeConversationId) return

    setIsTreeDrawerOpen(false)
    setIsPathPickerOpen(false)
    setScrollToMessageId(null)
    let cancelled = false

    const run = async () => {
      try {
        setStatusText('Loading messages…')
        await loadConversationTree(activeConversationId)
        if (!cancelled) {
          setBranchSourceMessage(null)
          setStatusText('Ready')
        }
      } catch (error) {
        if (!cancelled) {
          setStatusText(error instanceof Error ? error.message : String(error))
        }
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [activeConversationId, loadConversationTree])

  const applyStreamEvent = (event: HeadlessSseEvent) => {
    if (!event || typeof event !== 'object') return

    if (event.type === 'chunk' && event.part === 'text' && typeof event.delta === 'string') {
      setStreamingState(previous => {
        const next = previous || createStreamingState()
        return { ...next, text: `${next.text}${event.delta}` }
      })
      return
    }

    if (event.type === 'chunk' && event.part === 'reasoning' && typeof event.delta === 'string') {
      setStreamingState(previous => {
        const next = previous || createStreamingState()
        return { ...next, reasoning: `${next.reasoning}${event.delta}` }
      })
      return
    }

    if (event.type === 'chunk' && event.part === 'tool_call' && event.toolCall) {
      setStreamingState(previous => {
        const next = previous || createStreamingState()
        const toolId = String(event.toolCall.id || `tool-${next.toolOrder.length}`)
        const toolOrder = next.toolOrder.includes(toolId) ? next.toolOrder : [...next.toolOrder, toolId]

        return {
          ...next,
          toolOrder,
          toolCallsById: {
            ...next.toolCallsById,
            [toolId]: {
              ...event.toolCall,
              id: toolId,
            },
          },
        }
      })
      return
    }

    if (event.type === 'chunk' && event.part === 'tool_result' && event.toolResult) {
      setStreamingState(previous => {
        const next = previous || createStreamingState()
        return {
          ...next,
          toolResults: [...next.toolResults, event.toolResult],
        }
      })
      return
    }

    if (event.type === 'tool_execution') {
      setStatusText(`Tool ${event.toolName}: ${event.status}`)
      return
    }

    if (event.type === 'tool_loop') {
      if (event.status === 'turn_started') {
        setStatusText(`Tool loop turn ${event.turn}/${event.maxTurns} started…`)
      } else if (event.status === 'turn_completed') {
        setStatusText(
          event.continued
            ? `Tool loop turn ${event.turn}/${event.maxTurns} complete, continuing…`
            : `Tool loop turn ${event.turn}/${event.maxTurns} complete`
        )
      } else if (event.status === 'max_turns_reached') {
        setStatusText(`Tool loop reached max turns (${event.maxTurns})`)
      }
      return
    }

    if (event.type === 'complete' && event.message?.id) {
      lastStreamCompleteMessageIdRef.current = String(event.message.id)
      return
    }

    if (event.type === 'error' && typeof event.error === 'string') {
      setStatusText(event.error)
    }
  }

  const handleSend = async () => {
    if (sending) return
    if (!selectedUserId) {
      setStatusText('Select a user profile first')
      return
    }
    if (!activeConversationId) {
      setStatusText('Select or create a conversation first')
      return
    }
    if (selectedProvider === 'openaichatgpt' && !openAiConnected) {
      setStatusText('OpenAI not connected. Use Sign in OpenAI first.')
      return
    }
    if (selectedProvider === 'openrouter' && !openRouterConnected) {
      setStatusText('OpenRouter not connected.')
      return
    }

    const content = draft.trim()
    if (!content) return

    const isBranchSend = Boolean(branchSourceMessage)
    const streamOperation = isBranchSend ? 'edit-branch' : 'send'

    const currentBranchTipId =
      currentPathMessageIds[currentPathMessageIds.length - 1] || resolveLatestLeafMessageId(allMessages)

    const parentId = isBranchSend ? null : currentBranchTipId ?? null

    const optimisticUserMessage: MobileMessage = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      content,
      parent_id: isBranchSend ? branchSourceMessage?.parent_id ?? null : parentId,
      created_at: new Date().toISOString(),
    }

    lastStreamCompleteMessageIdRef.current = null
    setSending(true)
    setDraft('')
    setMessages(previous => [...previous, optimisticUserMessage])
    setStreamingState(createStreamingState())
    setStatusText(isBranchSend ? 'Streaming branched response…' : 'Streaming response…')

    try {
      await mobileApi.streamMessage({
        conversationId: activeConversationId,
        userId: selectedUserId,
        provider: selectedProvider,
        modelName,
        content,
        parentId,
        operation: streamOperation,
        messageId: branchSourceMessage?.id,
        cwd: activeProjectCwd,
        rootPath: activeProjectCwd,
        tools: inferenceTools,
        onEvent: applyStreamEvent,
      })

      setStatusText('Syncing messages…')
      await loadConversationTree(activeConversationId, {
        preferredMessageId: lastStreamCompleteMessageIdRef.current,
        preserveCurrentPath: true,
      })
      setBranchSourceMessage(null)
      setStatusText('Ready')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
      setStreamingState(null)
      lastStreamCompleteMessageIdRef.current = null
    }
  }

  const activeBranchTipId = currentPathMessageIds[currentPathMessageIds.length - 1] || null

  return (
    <main className='mobile-app-shell'>
      <MobileHeader
        providerName={selectedProvider}
        providerOptions={providerModels.length > 0 ? providerModels.map(provider => provider.name) : ['openaichatgpt', 'openrouter', 'lmstudio']}
        modelName={modelName}
        modelOptions={availableModelOptions}
        statusText={statusText}
        users={users}
        selectedUserId={selectedUserId}
        onProviderChange={setSelectedProvider}
        onModelChange={setModelName}
        onUserSelect={setSelectedUserId}
        selectorsDisabled={sending}
        openAiAuthenticated={openAiConnected}
        openRouterAuthenticated={openRouterConnected}
        openAiBusy={openAiBusy}
        hasPendingOpenAiFlow={Boolean(pendingOpenAiState)}
        onOpenAiLoginStart={handleOpenAiLoginStart}
        onOpenAiLoginComplete={handleOpenAiLoginComplete}
        onOpenAiLogout={handleOpenAiLogout}
        customTools={customTools}
        customToolBusyNames={customToolBusyNames}
        customToolsLoading={customToolsLoading}
        onRefreshCustomTools={loadCustomTools}
        onToggleCustomTool={handleToggleCustomTool}
        activeConversationId={activeConversationId}
        conversationSystemPromptInput={conversationSystemPromptInput}
        conversationContextInput={conversationContextInput}
        conversationCwdInput={conversationCwdInput}
        onConversationSystemPromptInputChange={setConversationSystemPromptInput}
        onConversationContextInputChange={setConversationContextInput}
        onConversationCwdInputChange={setConversationCwdInput}
        onSaveConversationSettings={handleSaveConversationSettings}
        savingConversationSettings={savingConversationSettings}
        onOpenProjectConversationPicker={() => setIsProjectsModalOpen(true)}
        canOpenProjectConversationPicker={!sending && Boolean(selectedUserId)}
        onOpenBranchTree={() => setIsTreeDrawerOpen(true)}
        canOpenBranchTree={Boolean(activeConversationId) && !sending && allMessages.length > 0}
        onOpenPathPicker={() => setIsPathPickerOpen(true)}
        canOpenPathPicker={Boolean(activeProjectCwd) && !sending && Boolean(activeConversationId)}
      />

      <ProjectConversationTree
        open={isProjectsModalOpen}
        projects={projects}
        conversationsByProjectKey={conversationsByProjectKey}
        expandedProjectKeys={expandedProjectKeys}
        activeConversationId={activeConversationId}
        loadingProjectKeys={loadingProjectKeys}
        onToggleProject={toggleProject}
        onSelectConversation={conversationId => {
          setActiveConversationId(conversationId)
          setIsProjectsModalOpen(false)
        }}
        onCreateProject={handleCreateProject}
        onCreateConversation={handleCreateConversation}
        onClose={() => setIsProjectsModalOpen(false)}
        disabled={sending || !selectedUserId}
      />

      <MessageList
        messages={displayedMessages}
        streamingMessage={streamingMessage}
        branchTargetMessageId={branchSourceMessage?.id || null}
        scrollToMessageId={scrollToMessageId}
        onScrollToMessageHandled={() => setScrollToMessageId(null)}
        userActionsDisabled={sending || !activeConversationId || !selectedUserId}
        currentUserId={selectedUserId}
        rootPath={activeProjectCwd}
        onBranchUserMessage={handleBranchUserMessage}
        onDeleteUserMessage={handleDeleteUserMessage}
      />

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={handleSend}
        sending={sending}
        isBranching={Boolean(branchSourceMessage)}
        branchLabel={
          branchSourceMessage
            ? `Branching from message ${branchSourceMessage.id.slice(0, 8)}… (new parent = previous message)`
            : undefined
        }
        onCancelBranch={branchSourceMessage ? handleCancelBranch : undefined}
        disabled={Boolean(composerDisabledReason)}
        onDisabledInteract={handleComposerDisabledInteract}
      />

      <FilePathPickerModal
        open={isPathPickerOpen}
        rootPath={activeProjectCwd}
        onClose={() => setIsPathPickerOpen(false)}
        onInsertPath={handleInsertPathIntoDraft}
      />

      <MessageTreeDrawer
        open={isTreeDrawerOpen}
        tree={treeForDrawer}
        activePathIds={currentPathMessageIds}
        activeTipId={activeBranchTipId}
        hideEmptyAssistantMessages={hideEmptyAssistantMessages}
        onToggleHideEmptyAssistantMessages={() => setHideEmptyAssistantMessages(previous => !previous)}
        onSelectMessage={handleSelectTreeNode}
        onClose={() => setIsTreeDrawerOpen(false)}
      />

      {composerBlockModal ? (
        <>
          <button
            type='button'
            aria-label='Close composer blocked dialog'
            className='mobile-blocked-modal-backdrop'
            onClick={() => setComposerBlockModal(null)}
          />
          <section className='mobile-blocked-modal' role='dialog' aria-modal='true' aria-label='Composer blocked'>
            <h3>{composerBlockModal.title}</h3>
            <p>{composerBlockModal.message}</p>
            <div className='mobile-blocked-modal-actions'>
              <Button onClick={() => setComposerBlockModal(null)} size='sm'>
                Got it
              </Button>
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}
