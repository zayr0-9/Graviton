/**
 * Dual-run parity harness (SKELETON — Phase 0 foundation).
 *
 * Goal (implemented incrementally in Phases 1–6): replay recorded provider/
 * Railway SSE fixtures through the server ChatOrchestrator + provider parser
 * against an in-memory better-sqlite3, and golden-compare against the CURRENT
 * renderer path on:
 *   - emitted HeadlessStreamEvent order/types
 *   - resulting message tree (ids, parent/children, content_blocks, tool_calls)
 *   - free_generations_update propagation and 403 -> generation_limit_reached
 *   - abort -> empty-assistant cleanup
 *
 * One suite per provider {openrouter, openaichatgpt, lmstudio, zai, bedrock} ×
 * operation {send, repeat, branch, edit-branch}. Fixtures live in ./__fixtures__.
 *
 * These are `it.todo` placeholders so the suite is green until each cell is
 * implemented. See ./__fixtures__/README.md for the fixture format.
 */

import { describe, it } from 'vitest'

const PROVIDERS = ['openrouter', 'openaichatgpt', 'lmstudio', 'zai', 'bedrock'] as const
const OPERATIONS = ['send', 'repeat', 'branch', 'edit-branch'] as const

describe('chat loop parity: server engine vs renderer path', () => {
  for (const provider of PROVIDERS) {
    for (const operation of OPERATIONS) {
      it.todo(`${provider} / ${operation}: message-tree + SSE-event parity`)
    }
  }

  it.todo('free_generations_update relays from Railway through the openrouter path')
  it.todo('HTTP 403 maps to a generation_limit_reached SSE event (not an opaque error)')
  it.todo('client disconnect aborts the run and cleans up the empty assistant message')
  it.todo('mid-run auto-compaction triggers at the same boundary as the renderer estimate')
})
