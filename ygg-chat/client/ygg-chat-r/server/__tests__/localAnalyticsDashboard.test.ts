import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateTokenCount } from 'tokenx'
import { buildLocalAnalyticsDashboard } from '../localAnalyticsDashboard.js'
import { summarizeDurations, summarizeOutcomes } from '../loggingAnalyticsMetrics.js'

const now = Date.parse('2026-10-01T12:00:00.000Z')
const recent = '2026-09-30T12:00:00.000Z'
const old = '2025-01-01T00:00:00.000Z'
let db: Database.Database
function message(id: string, conversation = 'c', model = 'model-a', time = recent, calls: unknown[] = [], blocks: unknown[] = []) {
  db.prepare('INSERT INTO messages VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)').run(
    id, conversation, 'assistant', model, JSON.stringify(calls), 'Hello world', 'Hello world', JSON.stringify(blocks), time)
}
function cost(id: string, messageId: string, time = recent) {
  db.prepare('INSERT INTO provider_cost VALUES (?, ?, 100, 50, 20, 0.25, 5, ?)').run(id, messageId, time)
}
const dashboard = (query: Record<string, unknown> = {}) => buildLocalAnalyticsDashboard(db, { rangeDays: '7', ...query }, now)

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE projects (id TEXT, name TEXT, created_at TEXT, storage_mode TEXT);
    CREATE TABLE conversations (id TEXT, project_id TEXT, title TEXT, created_at TEXT, storage_mode TEXT);
    CREATE TABLE messages (id TEXT, conversation_id TEXT, parent_id TEXT, role TEXT, model_name TEXT, tool_calls TEXT,
      content TEXT, plain_text_content TEXT, content_blocks TEXT, created_at TEXT);
    CREATE TABLE provider_cost (id TEXT, message_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
      approx_cost REAL, api_credit_cost REAL, created_at TEXT);
    CREATE TABLE tool_jobs (id TEXT, tool_name TEXT, status TEXT, conversation_id TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE streaming_runs (stream_id TEXT, conversation_id TEXT, model_name TEXT, stream_type TEXT, status TEXT, duration_ms INTEGER, started_at TEXT);
    CREATE TABLE tool_invocations (id TEXT, conversation_id TEXT, assistant_message_id TEXT, run_id TEXT, tool_name TEXT, status TEXT,
      parent_tool_invocation_id TEXT, duration_ms INTEGER, started_at TEXT);
  `)
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run('p', 'Old project', old, 'local')
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?)').run('c', 'p', 'Old conversation', old, 'local')
})
afterEach(() => db?.close())

describe('local logging aggregation', () => {
  it('includes recent activity in old entities and separates created from active counts', () => {
    message('m'); cost('cost', 'm')
    const result = dashboard({ projectId: 'p' })
    expect(result.summary).toMatchObject({ messagesTotal: 1, activeConversations: 1, activeProjects: 1,
      projectsCreated: 0, conversationsCreated: 0, netCreditsConsumed: 5 })
    expect(result.filters.available.projects.map(row => row.id)).toEqual(['p'])
    expect(result.filters.available.conversations.map(row => row.id)).toEqual(['c'])
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?)').run('new', 'p', 'New empty', recent, 'local')
    const after = dashboard({ projectId: 'p' })
    expect(after.summary.netCreditsConsumed).toBe(5)
    expect(after.summary.messagesTotal).toBe(1)
    expect(after.summary.conversationsCreated).toBe(1)
  })
  it('scopes explicit missing and mismatched entities to zero without leaking costs', () => {
    message('m'); cost('cost', 'm')
    expect(dashboard({ conversationId: 'missing' }).summary.netCreditsConsumed).toBe(0)
    expect(dashboard({ projectId: 'missing', conversationId: 'c' }).summary.messagesTotal).toBe(0)
    expect(dashboard({ projectId: 'missing' }).tools.jobs.total).toBe(0)
  })
  it('uses precise inclusive boundaries and excludes future and invalid dates', () => {
    message('edge', 'c', 'model-a', '2026-09-24T12:00:00.000Z')
    message('before', 'c', 'model-a', '2026-09-24T11:59:59.000Z')
    message('future', 'c', 'model-a', '2026-10-02T00:00:00.000Z')
    message('invalid', 'c', 'model-a', 'invalid')
    message('current', 'c', 'model-a', '2026-10-01T12:00:00.000Z')
    expect(dashboard().summary.messagesTotal).toBe(2)
  })
  it('preserves token components, does not double-count text, and keeps model options stable', () => {
    message('a', 'c', 'model-a', recent, [], [{ type: 'text', text: 'Hello world' }]); cost('a', 'a')
    message('b', 'c', 'model-b'); cost('b', 'b')
    const result = dashboard({ model: 'model-a' })
    expect(result.summary.estimatedTotalTokens).toBe(estimateTokenCount('Hello world'))
    expect(result.models.tokenMixByModel).toEqual([{ model: 'model-a', prompt: 100, completion: 50, reasoning: 20, samples: 1 }])
    expect(result.models.topByCredits[0].totalTokens).toBe(150)
    expect(result.filters.available.models).toEqual(['model-a', 'model-b'])
  })
  it('filters daily requested calls and exposes job-only names and stable statuses', () => {
    message('m', 'c', 'model-a', recent, [{ name: 'read_file' }, { function: { name: 'bash' } }])
    db.prepare('INSERT INTO tool_jobs VALUES (?, ?, ?, ?, ?, ?, ?)').run('j', 'job-only', 'failed', 'c', recent, recent, '2026-09-30T12:00:01Z')
    const result = dashboard({ toolName: 'read_file', toolStatus: 'completed' })
    expect(result.tools.requested).toEqual({ total: 1, byName: { read_file: 1 } })
    expect(result.tools.jobs.daily[0].requested).toBe(1)
    expect(result.filters.available.toolNames).toEqual(['bash', 'job-only', 'read_file'])
    expect(result.filters.available.toolJobStatuses).toContain('failed')
  })
  it('labels batching as structural expansion, without fabricated cache savings', () => {
    message('m', 'c', 'model-a', recent, [{ name: 'multi_call', args: { calls: [{ tool: 'read_file' }, { tool: 'bash' }, { tool: 'glob' }] } }, { name: 'glob' }])
    expect(dashboard().tools.batching).toMatchObject({ batchedCalls: 2, unbatchedEquivalentCalls: 4, savedCalls: 2,
      savedCallsPct: 50, cachePrefixSavingsFactorPct: 0 })
  })
  it('separates root/nested invocations and main/subagent runs with linked model filters', () => {
    message('a', 'c', 'model-a'); message('b', 'c', 'model-b')
    const addRun = db.prepare('INSERT INTO streaming_runs VALUES (?, ?, ?, ?, ?, ?, ?)')
    addRun.run('run-a', 'c', 'model-a', 'primary', 'completed', 100, recent)
    addRun.run('run-b', 'c', 'model-b', 'subagent', 'error', 200, recent)
    const addTool = db.prepare('INSERT INTO tool_invocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    addTool.run('root', 'c', 'a', 'run-a', 'multi_call', 'completed', null, 100, recent)
    addTool.run('child', 'c', 'a', 'run-a', 'read_file', 'failed', 'root', 50, recent)
    addTool.run('other', 'c', 'b', 'run-b', 'bash', 'aborted', null, null, recent)
    const all = dashboard()
    expect(all.executions.root).toMatchObject({ total: 2, statusCounts: { completed: 1, aborted: 1 } })
    expect(all.executions.nested).toMatchObject({ total: 1, failureRatePct: 100 })
    expect(all.localRuns.main.total).toBe(1)
    expect(all.localRuns.subagents.failureRatePct).toBe(100)
    const selected = dashboard({ model: 'model-a', runStatus: 'completed' })
    expect(selected.executions.root.total).toBe(1)
    expect(selected.executions.nested.total).toBe(1)
    expect(selected.localRuns.total).toBe(1)
    expect(selected.filters.available.runStatuses).toEqual(['completed', 'error'])
    expect(selected.filters.available.toolJobStatuses).toContain('aborted')
    expect(dashboard({ toolStatus: 'failed' }).executions.nested.total).toBe(1)
    expect(dashboard({ toolStatus: 'failed' }).executions.root.total).toBe(0)
  })
  it('deduplicates reported samples without adding them to cost usage or exporting response IDs', () => {
    const usage = (responseId?: string) => [{ type: 'openai_context_usage', usage: { inputTokens: 100, outputTokens: 40,
      cachedInputTokens: 60, reasoningTokens: 20, totalTokens: 140, ...(responseId ? { responseId } : {}) } }]
    message('a', 'c', 'model-a', recent, [], usage('private-response'))
    message('b', 'c', 'model-a', recent, [], usage('private-response'))
    message('c', 'c', 'model-a', recent, [], usage()); cost('cost', 'a')
    const result = dashboard()
    expect(result.reportedUsage).toMatchObject({ samples: 2, duplicateSamples: 1, unidentifiedSamples: 1,
      inputTokens: 200, outputTokens: 80, reasoningTokens: 40, totalTokens: 280, cachedInputPct: 60,
      messagesWithUsage: 3, assistantMessages: 3 })
    expect(result.spend.totals.promptTokens).toBe(100)
    expect(JSON.stringify(result)).not.toContain('private-response')
    expect(result.dataQuality.assistantMessagesWithCost).toBe(1)
  })
  it('distinguishes missing optional tables from broken queries and required schema', () => {
    db.exec('DROP TABLE tool_jobs; DROP TABLE tool_invocations; DROP TABLE streaming_runs; DROP TABLE provider_cost;')
    expect(dashboard().availability).toEqual({ jobs: false, executions: false, runs: false, costs: false })
    expect(dashboard().tools.jobs.available).toBe(false)
    db.exec('CREATE TABLE provider_cost (id TEXT)')
    expect(() => dashboard()).toThrow()
    db.exec('DROP TABLE provider_cost; DROP TABLE messages')
    expect(() => dashboard()).toThrow()
  })
  it('treats SQLite unzoned timestamps as UTC for days, creation counts, and durations', () => {
    message('sqlite', 'c', 'model-a', '2026-09-30 23:30:00')
    db.prepare('UPDATE projects SET created_at = ?').run('2026-10-01 11:59:00')
    db.prepare('INSERT INTO tool_jobs VALUES (?, ?, ?, ?, ?, ?, ?)').run('job', 'bash', 'completed', 'c',
      '2026-09-30 23:30:00', '2026-09-30 23:30:00', '2026-09-30T23:30:01Z')
    const result = dashboard()
    expect(result.summary.projectsCreated).toBe(1)
    expect(result.activity.messagesPerDay).toEqual([{ date: '2026-09-30', count: 1 }])
    expect(result.tools.jobs.averageDurationMs).toBe(1000)
  })
  it('handles deep reverse-ordered ancestry without recursive stack growth', () => {
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (let index = 12000; index >= 0; index--) insert.run(String(index), 'c', index ? String(index - 1) : null,
        'assistant', 'model-a', '[]', '', '', '[]', recent)
    })()
    const result = dashboard()
    expect(result.summary.messagesTotal).toBe(12001)
    expect(result.activity.branching.maxDepth).toBe(12000)
    expect(result.activity.branching.averageDepth).toBe(6000)
    db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run('12000', '0')
    expect(dashboard().activity.branching.maxDepth).toBe(0)
  })
  it('handles unknown and empty samples and clamps unsupported ranges', () => {
    expect(dashboard().reportedUsage.cachedInputPct).toBeNull()
    expect(dashboard().localRuns.failureRatePct).toBeNull()
    expect(dashboard().localRuns.duration.samples).toBe(0)
    expect(dashboard({ rangeDays: '9999' }).rangeDays).toBe(365)
  })
})

describe('duration and outcome semantics', () => {
  it('retains measured zero but excludes running, invalid, negative, and absent durations', () => {
    const rows = [0, 100, 300, -1, NaN, Infinity, null].map(duration_ms => ({ status: 'completed', duration_ms }))
    rows.push({ status: 'running', duration_ms: 400 })
    expect(summarizeDurations(rows)).toEqual({ samples: 3, averageMs: 400 / 3, p50Ms: 100, p90Ms: 300 })
    expect(summarizeOutcomes([{ status: 'running', duration_ms: null }]).failureRatePct).toBeNull()
    expect(summarizeOutcomes([{ status: 'error', duration_ms: 0 }, { status: 'aborted', duration_ms: 0 }]).failureRatePct).toBe(50)
  })
})
