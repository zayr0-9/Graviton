import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeSessionStore } from './claudeSessionStore.js'

const id = '11111111-1111-4111-8111-111111111111'

describe('Claude session storage adapter', () => {
  let root: string
  let project: string
  let store: ClaudeSessionStore
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-store-'))
    project = path.join(root, 'projects', 'encoded-project-name-is-not-a-path')
    fs.mkdirSync(project, { recursive: true })
    store = new ClaudeSessionStore(() => root)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (project: string, records: unknown[]) => {
    const file = path.join(project, `${id}.jsonl`)
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    return file
  }

  it('discovers JSONL-only stores and prioritizes sidecar names over transcript titles', async () => {
    write(project, [
      { type: 'user', cwd: root, message: { content: 'Do not expose first prompts in metadata' } },
      { type: 'summary', summary: 'Generated title' },
      { type: 'custom-title', sessionId: id, customTitle: 'Old title' },
      { type: 'custom-title', sessionId: id, customTitle: 'New title' },
    ])
    fs.mkdirSync(path.join(project, id))
    fs.writeFileSync(path.join(project, id, 'custom-title.json'), JSON.stringify({ customTitle: 'Human chosen title' }))
    const result = await store.discover()
    expect(result.sessions[0]).toMatchObject({ name: 'Human chosen title', cwd: fs.realpathSync(root), active: false })
    expect(result.sessions[0].aliases).toContain('Generated title')
    expect(JSON.stringify(result)).not.toContain('Do not expose')
  })

  it('reads optional legacy indexes only for real transcript files and never trusts indexed file paths', async () => {
    write(project, [{ type: 'user', message: { content: 'Hello' } }])
    fs.writeFileSync(path.join(project, 'sessions-index.json'), JSON.stringify({ entries: [
      { sessionId: id, customTitle: 'Index title', projectPath: root, fullPath: '/etc/passwd' },
      { sessionId: '22222222-2222-4222-8222-222222222222', customTitle: 'Deleted history', projectPath: '/etc' },
    ] }))
    const result = await store.discover()
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ name: 'Index title', cwd: fs.realpathSync(root), file: path.join(project, `${id}.jsonl`) })
  })

  it('uses head/tail windows for large histories and ignores broken JSON lines', async () => {
    const file = write(project, [{ type: 'user', cwd: root }, { type: 'tool', payload: 'x'.repeat(200000) }, { type: 'custom-title', sessionId: id, customTitle: 'Latest name' }])
    fs.appendFileSync(file, '{broken\n')
    const result = await store.discover()
    expect(result.sessions[0]).toMatchObject({ name: 'Latest name', metadataSampled: true })
    expect(result.incomplete).toBe(false)
  })

  it('ignores storage symlinks and does not decode lossy project folder names into paths', async () => {
    write(project, [{ type: 'summary', summary: 'No cwd' }])
    const result = await store.discover()
    expect(result.sessions[0].cwd).toBeUndefined()
    fs.symlinkSync(path.join(project, `${id}.jsonl`), path.join(project, '22222222-2222-4222-8222-222222222222.jsonl'))
    expect((await store.discover()).sessions).toHaveLength(1)
  })

  it('returns only user/assistant text and bounds an imported snapshot at its original byte count', async () => {
    const file = write(project, [
      { type: 'user', cwd: root, message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_result', content: 'Secret tool result' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }, { type: 'thinking', thinking: 'Private reasoning' }] } },
      { type: 'user', isSidechain: true, message: { content: 'Child text' } },
      { type: 'user', isMeta: true, message: { content: 'Internal control' } },
    ])
    const bytes = fs.statSync(file).size
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'Later response' } }) + '\n')
    const result = await store.readHistory({ sessionId: id, cwd: root, file, bytes })
    expect(result).toContain('Hello')
    expect(result).toContain('Answer')
    expect(result).not.toMatch(/Secret tool|Private reasoning|Child text|Internal control|Later response/)
  })

  it('charges index reads against the shared scan budget even when the ID is absent', async () => {
    for (let i = 0; i < 5; i++) {
      const directory = path.join(root, 'projects', `budget-${i}`)
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(directory, 'sessions-index.json'), JSON.stringify({ entries: [], padding: 'x'.repeat(700) }))
    }
    const bounded = new ClaudeSessionStore(() => root, 1000)
    const result = await bounded.discover({ sessionId: id })
    expect(result.incomplete).toBe(true)
    expect(result.sessions).toEqual([])
  })

  it('handles missing stores and honors cancellation', async () => {
    const missing = new ClaudeSessionStore(() => path.join(root, 'missing'))
    expect((await missing.discover()).sessions).toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(store.discover({ signal: controller.signal })).rejects.toThrow()
  })
})
