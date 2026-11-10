import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { submitMessageDraft } from '../components/ChatMessage/messageSubmission'

const chatSource = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8')
const messageSource = readFileSync(new URL('../components/ChatMessage/ChatMessage.tsx', import.meta.url), 'utf8')

function jsxRows(source: string) {
  const file = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rows: ts.JsxSelfClosingElement[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ChatMessage') rows.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return rows.map(row => Object.fromEntries(row.attributes.properties.filter(ts.isJsxAttribute).map(attr => [
    attr.name.getText(file), attr.initializer?.getText(file),
  ])))
}

function explainSubmit(disabled: boolean, branchDisabled = false) {
  const body = messageSource.match(/const handleSendExplainInput = \(\) => \{([\s\S]*?)\n    \}/)?.[1]
  if (!body) throw new Error('Missing explain submission callback')
  const submit = vi.fn(() => true)
  const close = vi.fn()
  new Function('onExplainFromSelection', 'selectedText', 'explainInputValue', 'submitMessageDraft',
    'branchSubmissionDisabled', 'explainSubmissionDisabled', 'id', 'setExplainInputClosing', body)(
    submit, 'selected words', 'Explain this', submitMessageDraft, branchDisabled, disabled, 'streaming', close
  )
  return { submit, close }
}

describe('streaming selection actions', () => {
  it('supplies every selection action on both live rendering surfaces', () => {
    const liveRows = jsxRows(chatSource).filter(row => row.id === "'streaming'")
    expect(liveRows).toHaveLength(2)
    for (const row of liveRows) {
      expect(row.onAddToNote).toBe('{handleAddToNote}')
      expect(row.onAddToChat).toBe('{handleAddToChat}')
      expect(row.onExplainFromSelection).toBe('{handleExplainFromSelection}')
      expect(row.explainSubmissionDisabled).toBe('{streamLifecycleActive || compactionActive || !liveExplainSourceReady}')
      expect(row.onExplainInputOpenChange).toBeDefined()
    }
  })

  it('blocks the shared click/Enter callback without closing the draft', () => {
    const blocked = explainSubmit(true)
    expect(blocked.submit).not.toHaveBeenCalled()
    expect(blocked.close).not.toHaveBeenCalled()
    const ready = explainSubmit(false)
    expect(ready.submit).toHaveBeenCalledWith('streaming', 'Explain this\n\nSelected text:\n```\nselected words\n```')
    expect(ready.close).toHaveBeenCalledWith(true)
    expect(explainSubmit(false, true).submit).not.toHaveBeenCalled()
    expect(messageSource).toContain('disabled={branchSubmissionDisabled || explainSubmissionDisabled || !explainInputValue.trim()}')
  })

  it('keeps Explain available and retains its live owner until the modal closes', () => {
    expect(messageSource).toContain('hasSelection && onExplainFromSelection')
    expect(chatSource).toContain("showLiveStreamingTail || liveExplainSurface === 'tail'")
    expect(chatSource).toContain("|| liveExplainSurface === 'virtual'")
    expect(chatSource).toContain('onExplainInputOpenChange={handleTailExplainOpenChange}')
    expect(chatSource).toContain('onExplainInputOpenChange={handleVirtualExplainOpenChange}')
  })

  it('rejects direct submission during generation before producing any side effects', () => {
    const body = chatSource.match(/const handleExplainFromSelection = useCallback\(\s*\(id: string, newContent: string\) => \{([\s\S]*?)\n    \},/)?.[1]
    if (!body) throw new Error('Missing explain callback')
    const compiled = ts.transpileModule(`function submit(id, newContent) {${body}}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    for (const [active, compacting] of [[true, false], [false, true]]) {
      const result = new Function('currentConversationId', 'selection', 'streamLifecycleActive', 'compactionActive',
        `${compiled}; return submit('streaming', 'question')`)('conversation', { status: 'ready' }, active, compacting)
      expect(result).toBe(false)
    }
    expect(body).toContain("id === 'streaming'")
    expect(body).toContain('liveExplainSourceRef.current?.messageId')
    expect(body).toContain('if (sourceId == null) return false')
  })
})
