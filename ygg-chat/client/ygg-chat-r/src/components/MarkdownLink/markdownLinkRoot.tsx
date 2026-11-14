import { createContext, useContext, type ReactNode } from 'react'
import { useAppSelector } from '../../hooks/redux'
import type { RootState } from '../../store/store'

/** Directory that relative Markdown file links resolve against (the conversation cwd). */
const MarkdownLinkRootContext = createContext<string | null>(null)

export function MarkdownLinkRootProvider({ root, children }: { root: string | null | undefined; children: ReactNode }) {
  const value = typeof root === 'string' && root.trim() ? root.trim() : null
  return <MarkdownLinkRootContext.Provider value={value}>{children}</MarkdownLinkRootContext.Provider>
}

export function useMarkdownLinkRoot(): string | null {
  return useContext(MarkdownLinkRootContext)
}

const nonEmpty = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** Mirrors the tool root used by chat sends: conversation cwd, then project cwd, then IDE workspace. */
export function selectConversationLinkRoot(state: RootState, conversationId: string | number | null | undefined): string | null {
  const id = conversationId == null ? null : String(conversationId)
  // Slices are optional here so isolated renderers (and partial test stores) still work.
  const conversation = id ? state.conversations?.items?.find(item => String(item.id) === id) : undefined
  const projectId = conversation?.project_id
  const project = projectId != null ? state.projects?.projects?.find(item => String(item.id) === String(projectId)) : undefined
  return nonEmpty(conversation?.cwd) ?? nonEmpty(project?.cwd) ?? nonEmpty(state.ideContext?.workspace?.rootPath)
}

/** Provider for surfaces that know their conversation, resolving its root from Redux. */
export function ConversationLinkRootProvider({ conversationId, fallbackRoot, children }: {
  conversationId: string | number | null | undefined
  fallbackRoot?: string | null
  children: ReactNode
}) {
  const root = useAppSelector(state => nonEmpty(fallbackRoot) ?? selectConversationLinkRoot(state, conversationId))
  return <MarkdownLinkRootProvider root={root}>{children}</MarkdownLinkRootProvider>
}
