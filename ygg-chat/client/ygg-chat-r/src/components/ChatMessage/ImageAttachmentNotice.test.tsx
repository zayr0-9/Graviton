import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImageAttachmentNotice, isImageAttachmentInfoMessage } from './ImageAttachmentNotice'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'
import { appendAttachedImagePathMetadata } from '../../features/chats/attachedImagePaths'
import { hasAcceptedImageAttachments } from '../../features/chats/acceptedImageAttachments'
import { estimateMessageRowHeight, smallChromeRowHeight } from './estimateMessageHeight'

vi.mock('../../features/chats/chatActions', () => ({ GENERATED_IMAGE_PATH_HINT_NOTE: '__generated_image_path_hint__' }))

describe('ImageAttachmentNotice', () => {
  it('acknowledges only persisted image attachment metadata, not drafts or path prose', () => {
    expect(hasAcceptedImageAttachments({ role: 'user', attachments: [{ id: 'a', mime_type: 'image/png' }] })).toBe(true)
    expect(hasAcceptedImageAttachments({ role: 'user', attachments: [{ dataUrl: 'data:image/png;base64,aQ==' }] })).toBe(false)
    expect(hasAcceptedImageAttachments({ role: 'user', attachments: [{ id: 'a', mime_type: 'application/pdf' }] })).toBe(false)
    expect(hasAcceptedImageAttachments({ role: 'user' })).toBe(false)
  })
  it('uses compact automated-message chrome with a stable anchor and no payload', () => {
    const html = renderToStaticMarkup(<ImageAttachmentNotice id='message-image' customThemeEnabled={false} />)
    expect(html).toContain('Image attached')
    expect(html).toContain('id="message-image"')
    expect(html).toContain('data-chat-image-attachment="true"')
    expect(html).toContain('flex h-8 items-center gap-2 px-2.5 text-xs text-stone-500 dark:text-stone-400')
    expect(html).not.toContain('rounded-2xl')
  })

  it('respects custom theme muted text in both modes', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.toolJobsMutedText.light = '#654321'
    theme.colors.toolJobsMutedText.dark = '#123456'
    for (const dark of [false, true]) {
      const html = renderToStaticMarkup(<ImageAttachmentNotice customTheme={theme} customThemeEnabled isDarkMode={dark} />)
      expect(html).toContain(`color:${dark ? '#123456' : '#654321'}`)
    }
  })

  it('requires the persisted marker instead of matching ordinary message text', () => {
    expect(isImageAttachmentInfoMessage({ note: '__generated_image_path_hint__' })).toBe(true)
    expect(isImageAttachmentInfoMessage({ note: 'Image attached' })).toBe(false)
    expect(isImageAttachmentInfoMessage({})).toBe(false)
    expect(isImageAttachmentInfoMessage(undefined)).toBe(false)
  })

  it('estimates one inline notice without treating hidden image paths as prose', () => {
    const input = {
      role: 'user', content: 'Inspect this', containerWidth: 720, rootFontSize: 16,
      fontSizeOffset: 0, groupToolReasoningRuns: false, artifactCount: 0, showsActionsRow: true,
    }
    const plainHeight = estimateMessageRowHeight(input)
    const content = appendAttachedImagePathMetadata(input.content, [
      `/private/${'long-directory/'.repeat(100)}a.png`, '/private/b.png',
    ])
    expect(estimateMessageRowHeight({ ...input, content })).toBe(plainHeight)
    expect(estimateMessageRowHeight({ ...input, content, hasAcceptedImages: true })).toBe(plainHeight + smallChromeRowHeight(16))
    const imageOnly = appendAttachedImagePathMetadata('', ['/private/a.png'])
    expect(estimateMessageRowHeight({ ...input, content: imageOnly, hasAcceptedImages: true, showsActionsRow: false }))
      .toBe(estimateMessageRowHeight({ ...input, content: '', showsActionsRow: false }) + smallChromeRowHeight(16))
  })
})
