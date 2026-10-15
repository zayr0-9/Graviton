import { readFileSync } from 'node:fs'
import { transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8')
const transcriptClass = source.match(/ref=\{messagesContainerRef\}\s+className=\{(`[^`]+`)\}/)?.[1]
const scrollEffect = source.match(/\/\/ Hide title bar on scroll down[^\n]*\n\s*useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[\]\)/)?.[1]
if (!transcriptClass || !scrollEffect) throw new Error('Missing primary transcript class or toolbar scroll effect')

// Exercise the container's real class expression and listener without mounting chat transports.
const getTranscriptClass = new Function('currentConversationId', 'editingTitle', 'isTitleBarVisible', `return ${transcriptClass}`) as
  (conversationId: string | null, editing: boolean, visible: boolean) => string
const attachScroll = new Function(
  'messagesContainerRef', 'lastScrollTopRef', 'editingTitleRef', 'setIsTitleBarVisible',
  'requestAnimationFrame', 'cancelAnimationFrame', transpileModule(scrollEffect, {}).outputText,
)

function toolbarScroll({ contentHeight = 900, editing = false } = {}) {
  let visible = true
  let top = 0
  let frames = new Map<number, () => void>()
  let frameId = 0
  let listener: (() => void) | undefined
  const changes: boolean[] = []
  const padding = () => {
    const classes = getTranscriptClass('conversation', editing, visible)
    const units = classes.match(/\bpt-(\d+)\b/)?.[1]
    if (!units) throw new Error('Missing transcript top clearance')
    return Number(units) * 4
  }
  const maxTop = () => Math.max(0, contentHeight + padding() - 500)
  const element = {
    get scrollTop() { return top },
    addEventListener: (_type: string, callback: () => void) => { listener = callback },
    removeEventListener: vi.fn(() => { listener = undefined }),
  }
  const lastScrollTopRef = { current: 0 }
  const cleanup = attachScroll(
    { current: element }, lastScrollTopRef, { current: editing },
    (next: boolean) => {
      if (next === visible) return
      visible = next
      changes.push(next)
      // Model the browser's maximum-scroll clamp after layout. Unlike jsdom, this
      // delivers the synthetic upward scroll that triggered the original feedback loop.
      const clamped = Math.min(top, maxTop())
      if (clamped !== top) {
        top = clamped
        listener?.()
      }
    },
    (callback: () => void) => { frames.set(++frameId, callback); return frameId },
    (id: number) => { frames.delete(id) },
  ) as () => void
  const flush = () => {
    const pending = frames
    frames = new Map()
    pending.forEach(callback => callback())
  }
  return {
    scrollTo(next: number) { top = Math.max(0, Math.min(next, maxTop())); listener?.(); flush() },
    flush,
    cleanup,
    element,
    changes,
    visible: () => visible,
    top: () => top,
    maxTop,
    pending: () => frames.size,
  }
}

describe('primary toolbar scroll geometry', () => {
  it.each([false, true])('keeps clearance unchanged by visibility (editing: %s)', editing => {
    const shown = getTranscriptClass('conversation', editing, true)
    const hidden = getTranscriptClass('conversation', editing, false)
    expect(hidden).toBe(shown)
    expect(hidden).toContain(editing ? 'pt-28' : 'pt-22')
    expect(hidden).not.toContain('transition-[padding-top]')
  })

  it('uses the small empty-chat inset without a conversation', () => {
    expect(getTranscriptClass(null, false, true)).toContain('pt-6')
  })

  it.each([500, 900])('does not clamp or re-show after a fast downward scroll at the bottom (content: %s)', contentHeight => {
    const chat = toolbarScroll({ contentHeight })
    const bottom = chat.maxTop()
    chat.scrollTo(bottom)
    // Further downward momentum must not restart visibility or change the scroll range.
    for (let frame = 0; frame < 20; frame++) chat.scrollTo(bottom + 100)
    expect(chat.top()).toBe(bottom)
    expect(chat.maxTop()).toBe(bottom)
    expect(chat.visible()).toBe(false)
    expect(chat.changes).toEqual([false])
    chat.cleanup()
  })

  it('still reveals on upward scrolling and at the top, and hides on downward scrolling', () => {
    const chat = toolbarScroll()
    chat.scrollTo(300)
    expect(chat.visible()).toBe(false)
    chat.scrollTo(280)
    expect(chat.visible()).toBe(true)
    chat.scrollTo(310)
    expect(chat.visible()).toBe(false)
    chat.scrollTo(0)
    expect(chat.visible()).toBe(true)
    chat.cleanup()
  })

  it('keeps the toolbar visible during rename', () => {
    const chat = toolbarScroll({ editing: true })
    chat.scrollTo(chat.maxTop())
    expect(chat.visible()).toBe(true)
    expect(chat.changes).toEqual([])
    chat.cleanup()
  })

  it('leaves non-scrollable conversations visible', () => {
    const chat = toolbarScroll({ contentHeight: 200 })
    chat.scrollTo(100)
    expect(chat.visible()).toBe(true)
    expect(chat.top()).toBe(0)
    chat.cleanup()
  })
})
