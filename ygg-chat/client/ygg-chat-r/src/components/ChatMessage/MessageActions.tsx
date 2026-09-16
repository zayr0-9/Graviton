import React from 'react'
import {
  Check,
  Copy,
  GitBranch,
  MessageCircleQuestion,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import {
  FAST_COLOR_TRANSITION_CLASS,
  FOCUS_RING_CLASS,
  TEXT_LABEL_CLASS,
  TEXT_NANO_CLASS,
} from './chatMessageShared'

export interface MessageActionsProps {
  onEdit?: () => void
  onBranch?: () => void
  onDelete?: () => void
  onCopy?: () => void
  onCopySelection?: () => void
  onExplainSelection?: (position?: { x: number; y: number }) => void
  onAddToNoteSelection?: () => void
  onResend?: () => void
  onSave?: () => void
  onCancel?: () => void
  onSaveBranch?: () => void
  onMore?: () => void
  onUndoEdits?: () => void
  undoLabel?: string
  undoDisabled?: boolean
  isEditing: boolean
  editMode?: 'edit' | 'branch'
  copied?: boolean
  modelName?: string
  isVisible?: boolean
  variant?: 'default' | 'selection'
  /** `pill` = inline hover cluster; `menu` = right-click list with labels. */
  layout?: 'pill' | 'menu'
}

type ActionTone = 'neutral' | 'success' | 'danger' | 'info' | 'warning'

const HOVER_TONE_CLASS: Record<ActionTone, string> = {
  neutral: 'hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/[0.08] dark:hover:text-white',
  success: 'hover:bg-emerald-500/12 hover:text-emerald-600 dark:hover:text-emerald-300',
  danger: 'hover:bg-red-500/12 hover:text-red-600 dark:hover:text-red-300',
  info: 'hover:bg-blue-500/12 hover:text-blue-600 dark:hover:text-blue-300',
  warning: 'hover:bg-amber-500/12 hover:text-amber-600 dark:hover:text-amber-300',
}

const ICON_SIZE = 15
const ICON_STROKE = 2

const formatModelName = (modelName: string): string => {
  const displayName = modelName.includes('/') ? modelName.split('/').pop() || modelName : modelName
  return displayName.length > 20 ? `${displayName.slice(0, 20)}…` : displayName
}

/**
 * Hover-revealed action cluster for a message. Pill layout is a circular control
 * cluster (agent_design.md); menu layout is the same actions with labels for the
 * right-click portal. No borders, no shadows. Feedback is fill and color only.
 */
export const MessageActions: React.FC<MessageActionsProps> = ({
  onEdit,
  onBranch,
  onDelete,
  onCopy,
  onCopySelection,
  onExplainSelection,
  onAddToNoteSelection,
  onSave,
  onCancel,
  onSaveBranch,
  onMore,
  onUndoEdits,
  undoLabel,
  undoDisabled,
  isEditing,
  editMode = 'edit',
  copied = false,
  modelName,
  isVisible = false,
  variant = 'default',
  layout = 'pill',
}) => {
  const isSelectionVariant = variant === 'selection'
  const isMenuLayout = layout === 'menu'
  const shouldShow = isVisible || isEditing

  const containerClass = isMenuLayout
    ? 'flex min-w-[180px] flex-col items-stretch gap-0.5 rounded-2xl bg-white/90 p-1.5 backdrop-blur-xl dark:bg-yBlack-900/90'
    : 'inline-flex items-center gap-0.5 rounded-full bg-white/70 p-1 backdrop-blur-xl dark:bg-white/[0.06]'

  const buttonBase = isMenuLayout
    ? `flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left ${TEXT_LABEL_CLASS} text-neutral-600 dark:text-neutral-300 ${FAST_COLOR_TRANSITION_CLASS} ${FOCUS_RING_CLASS}`
    : `flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 active:scale-95 transition-[background-color,color,transform] duration-150 ease-out ${FOCUS_RING_CLASS}`

  const renderAction = ({
    key,
    onClick,
    title,
    icon,
    label,
    tone = 'neutral',
    active,
    disabled,
  }: {
    key: string
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    title: string
    icon: React.ReactNode
    label: string
    tone?: ActionTone
    active?: boolean
    disabled?: boolean
  }) => (
    <button
      key={key}
      type='button'
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`${buttonBase} ${active ? 'text-emerald-600 dark:text-emerald-300' : HOVER_TONE_CLASS[tone]} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {icon}
      {isMenuLayout && <span className='truncate'>{label}</span>}
    </button>
  )

  const copyIcon = copied ? (
    <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />
  ) : (
    <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />
  )

  return (
    <div
      className={`${containerClass} transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
        shouldShow ? 'translate-y-0 opacity-100 pointer-events-auto' : 'translate-y-1 opacity-0 pointer-events-none'
      }`}
      role='toolbar'
      aria-label='Message actions'
    >
      {modelName && !isEditing && !isSelectionVariant && (
        <div
          className={`shrink-0 truncate font-mono ${TEXT_NANO_CLASS} uppercase tracking-wider text-neutral-500 dark:text-neutral-400 ${
            isMenuLayout ? 'px-3 py-1.5' : 'px-2.5'
          }`}
          title={modelName}
        >
          {formatModelName(modelName)}
        </div>
      )}

      {isEditing ? (
        <>
          {renderAction({
            key: 'save',
            onClick: editMode === 'branch' ? onSaveBranch : onSave,
            title: editMode === 'branch' ? 'Create branch' : 'Save changes',
            label: editMode === 'branch' ? 'Create branch' : 'Save',
            tone: 'success',
            icon: <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
          })}
          {renderAction({
            key: 'cancel',
            onClick: onCancel,
            title: 'Cancel editing',
            label: 'Cancel',
            tone: 'danger',
            icon: <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
          })}
        </>
      ) : isSelectionVariant ? (
        <>
          {onCopySelection &&
            renderAction({
              key: 'copy-selection',
              onClick: onCopySelection,
              title: copied ? 'Copied' : 'Copy selection',
              label: copied ? 'Copied' : 'Copy selection',
              active: copied,
              icon: copyIcon,
            })}
          {onExplainSelection &&
            renderAction({
              key: 'explain',
              onClick: event => onExplainSelection({ x: event.clientX, y: event.clientY }),
              title: 'Explain selection',
              label: 'Explain selection',
              tone: 'info',
              icon: <MessageCircleQuestion size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
          {onAddToNoteSelection &&
            renderAction({
              key: 'note',
              onClick: onAddToNoteSelection,
              title: 'Add selection to note',
              label: 'Add to note',
              tone: 'warning',
              icon: <NotebookPen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
        </>
      ) : (
        <>
          {onCopy &&
            renderAction({
              key: 'copy',
              onClick: onCopy,
              title: copied ? 'Copied' : 'Copy content',
              label: copied ? 'Copied' : 'Copy',
              active: copied,
              icon: copyIcon,
            })}
          {onEdit &&
            renderAction({
              key: 'edit',
              onClick: onEdit,
              title: 'Edit prompt',
              label: 'Edit',
              icon: <Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
          {onBranch &&
            renderAction({
              key: 'branch',
              onClick: onBranch,
              title: 'Branch message',
              label: 'Branch',
              tone: 'success',
              icon: <GitBranch size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
          {onDelete &&
            renderAction({
              key: 'delete',
              onClick: onDelete,
              title: 'Delete',
              label: 'Delete',
              tone: 'danger',
              icon: <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
          {onUndoEdits &&
            renderAction({
              key: 'undo',
              onClick: onUndoEdits,
              disabled: undoDisabled,
              title: undoLabel || 'Undo file edits',
              label: undoLabel || 'Undo edits',
              tone: 'warning',
              icon: <Undo2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
          {onMore &&
            renderAction({
              key: 'more',
              onClick: onMore,
              title: 'More options',
              label: 'More',
              icon: <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden='true' />,
            })}
        </>
      )}
    </div>
  )
}
