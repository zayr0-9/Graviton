import React from 'react'

interface DeleteConfirmModalProps {
  isOpen: boolean
  title?: string
  description?: string
  dontAskAgain?: boolean
  showDontAskAgain?: boolean
  dontAskAgainLabel?: string
  confirmLabel?: string
  cancelLabel?: string
  overlayBackgroundColor?: string
  backgroundColor?: string
  borderColor?: string
  titleTextColor?: string
  bodyTextColor?: string
  checkboxTextColor?: string
  cancelButtonBackgroundColor?: string
  cancelButtonBorderColor?: string
  cancelButtonTextColor?: string
  confirmButtonBackgroundColor?: string
  confirmButtonBorderColor?: string
  confirmButtonTextColor?: string
  onDontAskAgainChange?: (checked: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  title = 'Delete message?',
  description = 'This action cannot be undone.',
  dontAskAgain = false,
  showDontAskAgain = true,
  dontAskAgainLabel = "Don't ask again this session",
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  overlayBackgroundColor,
  backgroundColor,
  borderColor,
  titleTextColor,
  bodyTextColor,
  checkboxTextColor,
  cancelButtonBackgroundColor,
  cancelButtonBorderColor,
  cancelButtonTextColor,
  confirmButtonBackgroundColor,
  confirmButtonBorderColor,
  confirmButtonTextColor,
  onDontAskAgainChange,
  onCancel,
  onConfirm,
}) => {
  if (!isOpen) return null

  return (
    <div
      className='fixed inset-0 z-[100] flex items-center justify-center bg-black/50'
      onClick={onCancel}
      style={overlayBackgroundColor ? { backgroundColor: overlayBackgroundColor } : undefined}
    >
      <div
        className='w-[90%] max-w-sm rounded-2xl border p-6 shadow-xl'
        onClick={e => e.stopPropagation()}
        style={{
          backgroundColor: backgroundColor ?? 'var(--color-white, #ffffff)',
          borderColor: borderColor ?? 'rgba(0,0,0,0.08)',
        }}
      >
        <h3 className='mb-6 text-[20px] font-semibold' style={{ color: titleTextColor ?? 'rgb(23 23 23)' }}>
          {title}
        </h3>
        <p className='mb-4 text-[14px]' style={{ color: bodyTextColor ?? 'rgb(64 64 64)' }}>
          {description}
        </p>

        {showDontAskAgain && onDontAskAgainChange && (
          <label className='mb-4 flex items-center gap-2 text-sm' style={{ color: checkboxTextColor ?? bodyTextColor ?? 'rgb(64 64 64)' }}>
            <input type='checkbox' checked={dontAskAgain} onChange={e => onDontAskAgainChange(e.target.checked)} />
            {dontAskAgainLabel}
          </label>
        )}

        <div className='mt-8 flex justify-end gap-2'>
          <button
            type='button'
            onClick={onCancel}
            className='rounded-lg border px-4 py-2 text-sm font-medium transition-all duration-150 hover:opacity-90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50'
            style={{
              backgroundColor: cancelButtonBackgroundColor ?? 'transparent',
              borderColor: cancelButtonBorderColor ?? 'rgb(212 212 212)',
              color: cancelButtonTextColor ?? 'rgb(64 64 64)',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type='button'
            onClick={onConfirm}
            className='rounded-lg border px-4 py-2 text-sm font-medium transition-all duration-150 hover:opacity-90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50'
            style={{
              backgroundColor: confirmButtonBackgroundColor ?? 'rgb(220 38 38)',
              borderColor: confirmButtonBorderColor ?? 'rgb(185 28 28)',
              color: confirmButtonTextColor ?? '#ffffff',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
