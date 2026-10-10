import 'boxicons'
import 'boxicons/css/boxicons.min.css'
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../Button/button'

interface ImageModalProps {
  isOpen: boolean
  imageUrl: string
  onClose: () => void
  overlayZIndex?: number
}

export const ImageModal: React.FC<ImageModalProps> = ({ isOpen, imageUrl, onClose, overlayZIndex }) => {
  const surfaceRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen || !imageUrl) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    surfaceRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (trigger?.isConnected) trigger.focus() }
  }, [isOpen, imageUrl])
  if (!isOpen || !imageUrl) return null

  // Use portal to render at document body level, escaping any transform containers
  // that would otherwise constrain the fixed positioning
  return createPortal(
    <div
      ref={surfaceRef}
      role='dialog'
      aria-modal='true'
      aria-label='Image preview'
      className='fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm'
      style={{ zIndex: overlayZIndex }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
      onClick={onClose}
    >
      <div className='relative max-w-[95vw] max-h-[95vh] w-full' onClick={e => e.stopPropagation()}>
        <div className='pointer-events-auto absolute right-2 top-2 z-20'>
          <Button
            variant='outline'
            size='large'
            rounded='full'
            className='border border-white/30 bg-black/50 text-white shadow-lg shadow-black/40 hover:bg-black/60 focus:ring-0'
            onClick={onClose}
            aria-label='Close image preview'
          >
            <i className='bx bx-x text-3xl' aria-hidden='true'></i>
          </Button>
        </div>
        <img
          src={imageUrl}
          alt='Artifact preview'
          className='max-h-[90vh] w-full rounded-2xl border-2  border-neutral-200/60 dark:border-neutral-700 bg-black/80 object-contain shadow-[0_10px_30px_rgba(0,0,0,0.45)]'
        />
      </div>
    </div>,
    document.body
  )
}

export default ImageModal
