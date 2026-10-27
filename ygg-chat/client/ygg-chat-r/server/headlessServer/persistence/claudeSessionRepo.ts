import { executionPathAfterHandoff } from '../../../../../shared/summaryHandoff.js'
import { claudeMessageMetadata, isClaudeProvider } from '../../../../../shared/claudeProvider.js'
import type { HeadlessMessageRequest } from '../../../../../shared/headlessApi.js'

export const CLAUDE_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS claude_branch_sessions (
  lineage_id TEXT PRIMARY KEY REFERENCES lineages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL DEFAULT 'reserved'
);
CREATE TABLE IF NOT EXISTS claude_message_checkpoints (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_uuid TEXT NOT NULL,
  cwd TEXT NOT NULL,
  resumable INTEGER NOT NULL DEFAULT 0
);`

export type ClaudeCheckpoint = { session_id: string; message_uuid: string; cwd: string; resumable: number }
export class ClaudeSessionRepo {
  constructor(private db: any) {}
  branch(lineageId: string): any { return this.db.prepare('SELECT * FROM claude_branch_sessions WHERE lineage_id = ?').get(lineageId) }
  checkpoint(messageId: string): ClaudeCheckpoint | undefined {
    return this.db.prepare('SELECT * FROM claude_message_checkpoints WHERE message_id = ?').get(messageId)
  }
  reserve(lineageId: string, conversationId: string, model: string, cwd: string): void {
    this.db.prepare(`INSERT INTO claude_branch_sessions (lineage_id, conversation_id, model, cwd) VALUES (?, ?, ?, ?)
      ON CONFLICT(lineage_id) DO NOTHING`).run(lineageId, conversationId, model, cwd)
    const branch = this.branch(lineageId)
    if (branch.model !== model || branch.cwd !== cwd) throw new Error('Claude branch model and workspace are locked. Start a new conversation.')
  }
  session(lineageId: string, sessionId: string, state: string): void {
    this.db.prepare('UPDATE claude_branch_sessions SET session_id = ?, state = ? WHERE lineage_id = ?').run(sessionId, state, lineageId)
  }
  record(messageId: string, sessionId: string, uuid: string, cwd: string, resumable: boolean): void {
    this.db.prepare(`INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id, message_uuid=excluded.message_uuid,
      cwd=excluded.cwd, resumable=excluded.resumable`).run(messageId, sessionId, uuid, cwd, resumable ? 1 : 0)
  }
  /** Branches whose last run never reached a result. At host startup none can still be live. */
  interruptedBranches(): Array<{ lineage_id: string; session_id: string | null; cwd: string; head_message_id: string | null }> {
    return this.db.prepare(`SELECT b.lineage_id, b.session_id, b.cwd, l.head_message_id FROM claude_branch_sessions b
      JOIN lineages l ON l.id = b.lineage_id WHERE b.state IN ('running', 'uncertain')`).all()
  }
  setState(lineageId: string, state: string): void {
    this.db.prepare('UPDATE claude_branch_sessions SET state = ? WHERE lineage_id = ?').run(state, lineageId)
  }
}

/** Validate against persisted ancestry, never a renderer draft. Does not change existing API-provider switching. */
export function assertClaudeBranchSelection(request: HeadlessMessageRequest, path: any[]): void {
  const selected = isClaudeProvider(request.provider)
  path = executionPathAfterHandoff(path)
  const recorded = path.map(row => claudeMessageMetadata(row.meta)?.modelSelection).filter(Boolean)
  const claude = recorded.find(pair => isClaudeProvider(pair.provider))
  if (claude && (!selected || request.modelName !== claude.model)) {
    throw Object.assign(new Error('Claude branches have a fixed provider and model. Start a new conversation to change them.'), { code: 'configuration_mismatch' })
  }
  if (selected && path.length && !claude) {
    throw Object.assign(new Error('Claude requires a new conversation; existing provider history cannot be imported.'), { code: 'configuration_mismatch' })
  }
}
