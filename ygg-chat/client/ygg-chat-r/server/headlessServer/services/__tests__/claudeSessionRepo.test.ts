import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { CLAUDE_SESSION_SCHEMA, ClaudeSessionRepo } from '../../persistence/claudeSessionRepo.js'
import { classifyChatError } from '../../providers/providerErrorFormatter.js'
import { claudeProcessEnvironment } from '../claudeProcessConfig.js'
import { isClaudeTranscriptMessage } from '../../../../../../shared/claudeProvider.js'

describe('Claude durable session state', () => {
  it('creates idempotent schema, locks workspace, tracks the latest model and cascades projection checkpoints', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY); CREATE TABLE messages(id TEXT PRIMARY KEY); CREATE TABLE lineages(id TEXT PRIMARY KEY);')
      db.exec(CLAUDE_SESSION_SCHEMA); db.exec(CLAUDE_SESSION_SCHEMA)
      db.exec("INSERT INTO conversations VALUES ('c'); INSERT INTO lineages VALUES ('l'); INSERT INTO messages VALUES ('m');")
      const repo = new ClaudeSessionRepo(db)
      repo.reserve('l', 'c', 'model', '/workspace')
      repo.reserve('l', 'c', 'other', '/workspace')
      expect(() => repo.reserve('l', 'c', 'third', '/other')).toThrow('workspace is locked')
      try { repo.reserve('l', 'c', 'third', '/other') } catch (error) {
        const envelope = classifyChatError(error)
        expect(envelope.code).toBe('claude_workspace_changed')
        expect(envelope.action).toBeUndefined()
        expect(envelope.detail).toContain('Original folder: /workspace')
        expect(envelope.detail).toContain('Selected folder: /other')
      }
      repo.session('l', 'session', 'ready')
      repo.record('m', 'session', 'uuid', '/workspace', true)
      expect(repo.branch('l')).toMatchObject({ session_id: 'session', model: 'other', cwd: '/workspace', state: 'ready' })
      expect(repo.checkpoint('m')).toMatchObject({ message_uuid: 'uuid', resumable: 1 })
      db.exec("DELETE FROM messages WHERE id='m'; DELETE FROM conversations WHERE id='c';")
      expect(repo.checkpoint('m')).toBeUndefined()
      expect(repo.branch('l')).toBeUndefined()
    } finally { db.close() }
  })
  it('does not expose Graviton app credentials to native tools', () => {
    const env = claudeProcessEnvironment({ HOME: '/home/test', PATH: '/bin', ANTHROPIC_API_KEY: 'test-api',
      OPENAI_CHATGPT_ACCESS_TOKEN: 'must-not-inherit', EXAMPLE_SERVICE_ROLE_KEY: 'must-not-inherit',
      ELECTRON_RUN_AS_NODE: '1', CLAUDECODE: '1', NODE_OPTIONS: '--inspect', AWS_SECRET_ACCESS_KEY: 'must-not-inherit', GOOGLE_APPLICATION_CREDENTIALS: '/private/key' })
    expect(env.ANTHROPIC_API_KEY).toBe('test-api')
    for (const key of ['OPENAI_CHATGPT_ACCESS_TOKEN', 'EXAMPLE_SERVICE_ROLE_KEY', 'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) expect(env[key]).toBeUndefined()
  })
  it.each(['Claude Code', 'claudecode', 'claude', 'anthropic(claudecli)'])('detects immutable transcript identity for %s on user and assistant metadata', provider => {
    expect(isClaudeTranscriptMessage({ meta: JSON.stringify({ modelSelection: { provider } }) })).toBe(true)
    expect(isClaudeTranscriptMessage({ meta: { claude: { sessionId: 's' } } })).toBe(true)
    expect(isClaudeTranscriptMessage({ meta: '{bad' })).toBe(false)
  })
})
