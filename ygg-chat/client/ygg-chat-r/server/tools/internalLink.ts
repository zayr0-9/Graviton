export interface InternalLinkArgs {
  projectId?: string
  conversationId?: string
  messageId?: string
  // Optional display label shown in UI cards
  label?: string
  // Alias keys accepted for model/tool-call flexibility
  project_id?: string
  conversation_id?: string
  message_id?: string
  chatMessageId?: string
}

interface InternalLinkExecuteOptions {
  currentConversationId?: string | null
  getConversationById: (conversationId: string) => Record<string, any> | undefined
  getMessageById: (messageId: string) => Record<string, any> | undefined
}

interface InternalLinkResolution {
  routeType: 'project' | 'conversation'
  projectId: string | null
  conversationId: string | null
  messageId: string | null
  route: string | null
  canNavigate: boolean
  conversationTitle: string | null
}

const normalizeId = (value: unknown): string | null => {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const buildProjectRoute = (projectId: string): string => {
  const encodedProject = encodeURIComponent(projectId)
  return `/conversationPage?projectId=${encodedProject}`
}

const buildChatRoute = (projectId: string | null, conversationId: string, messageId: string | null): string => {
  const projectSegment = projectId || 'unknown'
  const encodedProject = encodeURIComponent(projectSegment)
  const encodedConversation = encodeURIComponent(conversationId)
  const hash = messageId ? `#${encodeURIComponent(messageId)}` : ''
  return `/chat/${encodedProject}/${encodedConversation}${hash}`
}

export async function execute(
  args: InternalLinkArgs,
  options: InternalLinkExecuteOptions
): Promise<{
  success: boolean
  error?: string
  label?: string | null
  target?: InternalLinkResolution
  warnings?: string[]
}> {
  const warnings: string[] = []

  const requestedProjectId = normalizeId(args?.projectId ?? args?.project_id)
  const requestedConversationId = normalizeId(args?.conversationId ?? args?.conversation_id)
  const requestedMessageId = normalizeId(args?.messageId ?? args?.message_id ?? args?.chatMessageId)
  const requestedLabel = normalizeText(args?.label)
  const currentConversationId = normalizeId(options.currentConversationId)

  if (!requestedProjectId && !requestedConversationId && !requestedMessageId && !currentConversationId) {
    return {
      success: false,
      error:
        'Provide at least one identifier (projectId, conversationId, or messageId), or call from a conversation context.',
    }
  }

  let resolvedMessageId: string | null = requestedMessageId
  let resolvedConversationId: string | null = requestedConversationId || currentConversationId
  let resolvedProjectId: string | null = requestedProjectId

  // 1) Message id is the strongest anchor; derive conversation from message.
  if (requestedMessageId) {
    const message = options.getMessageById(requestedMessageId)
    if (!message) {
      return {
        success: false,
        error: `Message not found: ${requestedMessageId}`,
      }
    }

    const messageConversationId = normalizeId(message?.conversation_id)
    if (!messageConversationId) {
      return {
        success: false,
        error: `Message ${requestedMessageId} is missing conversation_id`,
      }
    }

    if (requestedConversationId && requestedConversationId !== messageConversationId) {
      warnings.push('conversationId did not match messageId; using the message conversation instead.')
    }

    resolvedConversationId = messageConversationId
  }

  // 2) Resolve conversation/project coherence when conversation is known.
  let conversationRecord: Record<string, any> | undefined
  if (resolvedConversationId) {
    conversationRecord = options.getConversationById(resolvedConversationId)
    if (!conversationRecord) {
      return {
        success: false,
        error: `Conversation not found: ${resolvedConversationId}`,
      }
    }

    const conversationProjectId = normalizeId(conversationRecord?.project_id)
    if (!resolvedProjectId && conversationProjectId) {
      resolvedProjectId = conversationProjectId
    } else if (resolvedProjectId && conversationProjectId && resolvedProjectId !== conversationProjectId) {
      warnings.push('projectId did not match conversationId; using the conversation project instead.')
      resolvedProjectId = conversationProjectId
    }
  }

  // 3) If we only have project id, return a project-scoped route.
  if (!resolvedConversationId && resolvedProjectId) {
    return {
      success: true,
      label: requestedLabel ?? null,
      target: {
        routeType: 'project',
        projectId: resolvedProjectId,
        conversationId: null,
        messageId: null,
        route: buildProjectRoute(resolvedProjectId),
        canNavigate: true,
        conversationTitle: null,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  if (!resolvedConversationId) {
    return {
      success: false,
      error: 'Unable to resolve conversation target.',
    }
  }

  const conversationTitle = normalizeText(conversationRecord?.title)
  const route = buildChatRoute(resolvedProjectId, resolvedConversationId, resolvedMessageId)

  return {
    success: true,
    label: requestedLabel ?? conversationTitle ?? null,
    target: {
      routeType: 'conversation',
      projectId: resolvedProjectId,
      conversationId: resolvedConversationId,
      messageId: resolvedMessageId,
      route,
      canNavigate: true,
      conversationTitle,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

export default { execute }
