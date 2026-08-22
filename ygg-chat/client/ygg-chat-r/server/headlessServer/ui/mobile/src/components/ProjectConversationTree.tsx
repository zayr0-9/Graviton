import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './ui'
import type { MobileConversation, MobileProject } from '../types'

interface ProjectConversationTreeProps {
  open: boolean
  projects: MobileProject[]
  conversationsByProjectKey: Record<string, MobileConversation[]>
  expandedProjectKeys: string[]
  activeConversationId: string | null
  loadingProjectKeys: string[]
  onToggleProject: (projectId: string | null) => void
  onSelectConversation: (conversationId: string) => void
  onCreateProject: () => void
  onCreateConversation: (projectId: string | null) => void
  onClose: () => void
  disabled?: boolean
}

const keyForProject = (projectId: string | null) => projectId || '__none__'

const ProjectGroup: React.FC<{
  title: string
  projectId: string | null
  conversations: MobileConversation[]
  expanded: boolean
  loading: boolean
  activeConversationId: string | null
  onToggleProject: (projectId: string | null) => void
  onSelectConversation: (conversationId: string) => void
  onCreateConversation: (projectId: string | null) => void
  disabled: boolean
}> = ({
  title,
  projectId,
  conversations,
  expanded,
  loading,
  activeConversationId,
  onToggleProject,
  onSelectConversation,
  onCreateConversation,
  disabled,
}) => {
  return (
    <section className='mobile-project-group'>
      <button className='mobile-project-header' onClick={() => onToggleProject(projectId)}>
        <span>{title}</span>
        <span className='mobile-project-meta'>{expanded ? '−' : '+'}</span>
      </button>

      {expanded ? (
        <div className='mobile-project-body'>
          <div className='mobile-project-actions'>
            <Button onClick={() => onCreateConversation(projectId)} disabled={disabled} size='sm' variant='outline'>
              New conversation
            </Button>
          </div>

          {loading ? <div className='mobile-tree-muted'>Loading conversations…</div> : null}

          {!loading && conversations.length === 0 ? (
            <div className='mobile-tree-muted'>No conversations</div>
          ) : null}

          {!loading
            ? conversations.map(conversation => (
                <Button
                  key={conversation.id}
                  className={`mobile-conversation-row ${activeConversationId === conversation.id ? 'active' : ''}`}
                  onClick={() => onSelectConversation(conversation.id)}
                  variant='ghost'
                  size='sm'
                >
                  {conversation.title || 'Untitled Conversation'}
                </Button>
              ))
            : null}
        </div>
      ) : null}
    </section>
  )
}

export const ProjectConversationTree: React.FC<ProjectConversationTreeProps> = ({
  open,
  projects,
  conversationsByProjectKey,
  expandedProjectKeys,
  activeConversationId,
  loadingProjectKeys,
  onToggleProject,
  onSelectConversation,
  onCreateProject,
  onCreateConversation,
  onClose,
  disabled = false,
}) => {
  useEffect(() => {
    if (!open) return

    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousBodyOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const modal = (
    <>
      <button
        type='button'
        aria-label='Close projects panel'
        className='mobile-project-modal-backdrop open'
        onClick={onClose}
      />

      <section className='mobile-project-modal open' role='dialog' aria-modal='true' aria-label='Projects'>
        <header className='mobile-project-modal-header'>
          <strong>Projects & Conversations</strong>
          <Button onClick={onClose} variant='outline' size='sm'>
            Close
          </Button>
        </header>

        <div className='mobile-project-modal-body'>
          <div className='mobile-project-tree'>
            <div className='mobile-project-tree-header'>
              <span className='mobile-tree-muted'>Manage projects and pick a conversation</span>
              <Button onClick={onCreateProject} disabled={disabled} size='sm'>
                New project
              </Button>
            </div>

            {projects.map(project => {
              const projectKey = keyForProject(project.id)
              return (
                <ProjectGroup
                  key={project.id}
                  title={project.name || 'Untitled Project'}
                  projectId={project.id}
                  conversations={conversationsByProjectKey[projectKey] || []}
                  expanded={expandedProjectKeys.includes(projectKey)}
                  loading={loadingProjectKeys.includes(projectKey)}
                  activeConversationId={activeConversationId}
                  onToggleProject={onToggleProject}
                  onSelectConversation={onSelectConversation}
                  onCreateConversation={onCreateConversation}
                  disabled={disabled}
                />
              )
            })}

          </div>
        </div>
      </section>
    </>
  )

  return createPortal(modal, document.body)
}
