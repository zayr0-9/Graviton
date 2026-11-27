import { describe, expect, it } from 'vitest'
import { parseAppsHandoff } from '../../platform/appsWindow'
import type { HtmlIframeEntry } from './HtmlIframeRegistry'
import { mergeTransferredEntry, parseTransferredEntry, toTransferableEntry } from './appsHandoffEntries'

const htmlEntry: HtmlIframeEntry = {
  key: 'm1-tool-result-0',
  kind: 'html',
  html: '<p>hi</p>',
  src: null,
  label: 'Chart',
  favorite: true,
  status: 'active',
  sizeBytes: 9,
  createdAt: 100,
  updatedAt: 200,
  lastUsedAt: 300,
  conversationId: 'c1',
  projectId: null,
  toolName: 'chart_tool',
}

const mcpEntry: HtmlIframeEntry = {
  key: 'mcp-1',
  kind: 'mcp',
  label: null,
  favorite: false,
  status: 'hibernated',
  sizeBytes: 0,
  createdAt: 1,
  updatedAt: 2,
  lastUsedAt: 3,
  conversationId: null,
  projectId: null,
  toolName: null,
  serverName: 'srv',
  resourceUri: 'ui://app',
  qualifiedToolName: 'mcp__srv__tool',
  toolArgs: { q: 1 },
  toolResult: { content: [{ type: 'text', text: 'ok' }] },
  reloadToken: 4,
}

describe('apps window entry hand-off', () => {
  it('round-trips HTML and MCP entries through a JSON copy', () => {
    for (const entry of [htmlEntry, mcpEntry]) {
      const copy = toTransferableEntry(entry)
      expect(copy).not.toBe(entry)
      expect(parseTransferredEntry(structuredClone(copy))).toEqual(entry)
    }
  })

  it('drops values that cannot cross IPC', () => {
    const withFunction = { ...mcpEntry, toolDefinition: { name: 'x', run: () => 1 } } as unknown as HtmlIframeEntry
    const copy = toTransferableEntry(withFunction) as any
    expect(copy.toolDefinition).toEqual({ name: 'x' })
    const cyclic: any = { ...htmlEntry }
    cyclic.self = cyclic
    expect(toTransferableEntry(cyclic)).toBeNull()
  })

  it('rejects malformed entries and fills missing numbers', () => {
    expect(parseTransferredEntry(null)).toBeNull()
    expect(parseTransferredEntry({ key: '', kind: 'html', html: 'x' })).toBeNull()
    expect(parseTransferredEntry({ key: 'a', kind: 'html' })).toBeNull()
    expect(parseTransferredEntry({ key: 'a', kind: 'mcp', serverName: 's', resourceUri: 'u' })).toBeNull()
    const parsed = parseTransferredEntry({ key: 'a', kind: 'html', html: 'x', status: 'weird', favorite: 'yes' }, 42)
    expect(parsed).toMatchObject({ key: 'a', status: 'active', favorite: false, createdAt: 42, lastUsedAt: 42, sizeBytes: 0 })
  })

  it('merges a forwarded entry: sender content and status, receiver favourite and creation time', () => {
    const existing = { ...htmlEntry, favorite: true, createdAt: 5, lastUsedAt: 900, status: 'hibernated' as const }
    const incoming = { ...htmlEntry, html: '<p>new</p>', favorite: false, createdAt: 50, lastUsedAt: 400, status: 'active' as const }
    expect(mergeTransferredEntry(existing, incoming)).toMatchObject({
      html: '<p>new</p>',
      status: 'active',
      favorite: true,
      createdAt: 5,
      lastUsedAt: 900,
    })
    expect(mergeTransferredEntry(undefined, incoming)).toBe(incoming)
  })

  it('parses hand-off envelopes', () => {
    expect(parseAppsHandoff({ mode: 'merge', entries: [], focusKey: 'k' })).toEqual({ mode: 'merge', entries: [], focusKey: 'k' })
    expect(parseAppsHandoff({ mode: 'replace', entries: [1], focusKey: 3 })).toEqual({ mode: 'replace', entries: [1], focusKey: null })
    expect(parseAppsHandoff({ mode: 'other', entries: [] })).toBeNull()
    expect(parseAppsHandoff({ mode: 'merge' })).toBeNull()
    expect(parseAppsHandoff('x')).toBeNull()
  })
})
