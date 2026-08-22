// server/routes/noteSearchRoutes.ts
//
// Conversation/note search engine and routes, extracted verbatim from
// localServer.ts setupServer(): /api/local/conversations/search,
// /api/local/conversations/search/notes* (FTS + fuzzy + optional
// sqlite-vec vector search, LM Studio embeddings), and
// /api/local/conversations/search/top-level-users.
//
// Returns the searchNotes / searchTopLevelUserMessages functions so the
// caller can hand them to the built-in tool registry (fetch_notes /
// fetch_chats run the same search code as the routes).

import type Database from 'better-sqlite3'
import crypto from 'crypto'
import type { Express } from 'express'
import {
  embedText as embedTextWithLmStudio,
  embedTexts as embedTextsWithLmStudio,
  getLmStudioBaseUrl,
} from '../headlessServer/providers/lmStudioEmbeddings.js'

export interface NoteSearchRoutesDeps {
  db: Database.Database
  statements: any
  getSqliteVecAvailable: () => boolean
  getSqliteVecLoadError: () => string | null
}

export interface NoteSearchHandles {
  searchNotes: (params: { userId: string; query: string; projectId?: string; limit: number }) => Array<Record<string, any>>
  searchTopLevelUserMessages: (params: { userId: string; query: string; projectId?: string; limit: number }) => Array<Record<string, any>>
}

export function registerNoteSearchRoutes(app: Express, deps: NoteSearchRoutesDeps): NoteSearchHandles {
  const { db, statements } = deps
  const getSqliteVecAvailable = deps.getSqliteVecAvailable
  const getSqliteVecLoadError = deps.getSqliteVecLoadError

  type TopLevelMessageSearchCandidate = {
    message_id: string
    conversation_id: string
    project_id: string | null
    storage_mode: 'cloud' | 'local'
    conversation_title: string | null
    conversation_updated_at: string | null
    message_created_at: string
    message_content: string
    message_plain_text_content: string | null
    message_note: string | null
    relevance: number
    match_type: 'fts' | 'fuzzy'
  }

  const TOP_LEVEL_MESSAGE_SEARCH_FTS_CANDIDATE_LIMIT = 220
  const TOP_LEVEL_MESSAGE_SEARCH_FUZZY_CANDIDATE_LIMIT = 900

  const normalizeSearchText = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  const splitSearchTokens = (value: string) => {
    const normalized = normalizeSearchText(value)
    if (!normalized) return []
    return Array.from(new Set(normalized.split(' ').filter(Boolean))).slice(0, 8)
  }

  const buildStrictFtsQuery = (tokens: string[]) => {
    if (tokens.length === 0) return ''
    return tokens.map(token => `"${token}"`).join(' AND ')
  }

  const buildRelaxedFtsQuery = (tokens: string[]) => {
    if (tokens.length === 0) return ''
    return tokens.map(token => `"${token}"*`).join(' OR ')
  }

  const levenshteinDistance = (a: string, b: string): number => {
    if (!a.length) return b.length
    if (!b.length) return a.length

    const matrix: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
    for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i
    for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j

    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        )
      }
    }

    return matrix[a.length][b.length]
  }

  const bestTokenSimilarity = (queryToken: string, candidateTokens: string[]): number => {
    let best = 0

    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) return 1

      if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) {
        best = Math.max(best, 0.92)
        continue
      }

      const maxLength = Math.max(queryToken.length, candidateToken.length)
      if (!maxLength) continue
      const distance = levenshteinDistance(queryToken, candidateToken)
      const similarity = 1 - distance / maxLength
      if (similarity > best) best = similarity
    }

    return best
  }

  const calculateFuzzyRelevance = (query: string, messageText: string, note: string | null): number => {
    const normalizedQuery = normalizeSearchText(query)
    if (!normalizedQuery) return 0

    const combinedText = `${note || ''} ${messageText || ''}`
    const normalizedText = normalizeSearchText(combinedText)
    if (!normalizedText) return 0

    if (normalizedText.includes(normalizedQuery)) {
      return 1.2
    }

    const queryTokens = splitSearchTokens(query)
    if (queryTokens.length === 0) return 0

    const candidateTokens = Array.from(new Set(normalizedText.split(' ').filter(Boolean))).slice(0, 120)
    if (candidateTokens.length === 0) return 0

    let total = 0
    for (const queryToken of queryTokens) {
      total += bestTokenSimilarity(queryToken, candidateTokens)
    }

    const averageSimilarity = total / queryTokens.length
    const shortQueryBoost = normalizedQuery.length <= 5 ? 0.94 : 1
    return averageSimilarity * shortQueryBoost
  }

  const buildMessageSnippet = (rawText: string, rawQuery: string, maxLength: number = 220): string => {
    const text = (rawText || '').replace(/\s+/g, ' ').trim()
    if (!text) return ''
    if (text.length <= maxLength) return text

    const lowerText = text.toLowerCase()
    const lowerQuery = rawQuery.toLowerCase().trim()
    const matchIndex = lowerQuery ? lowerText.indexOf(lowerQuery) : -1

    if (matchIndex === -1) {
      return `${text.slice(0, maxLength).trim()}…`
    }

    const halfWindow = Math.floor(maxLength / 2)
    const start = Math.max(0, matchIndex - halfWindow)
    const end = Math.min(text.length, start + maxLength)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < text.length ? '…' : ''
    return `${prefix}${text.slice(start, end).trim()}${suffix}`
  }

  const NOTE_SEARCH_FTS_CANDIDATE_LIMIT = 220
  const NOTE_SEARCH_FUZZY_CANDIDATE_LIMIT = 1200
  const NOTE_SEARCH_VECTOR_CANDIDATE_LIMIT = 80

  const normalizeEmbeddingInput = (embedding: unknown): number[] => {
    if (Array.isArray(embedding)) {
      return embedding.map(value => Number(value)).filter(value => Number.isFinite(value))
    }

    if (typeof embedding === 'string') {
      try {
        const parsed = JSON.parse(embedding)
        return normalizeEmbeddingInput(parsed)
      } catch {
        return []
      }
    }

    return []
  }

  const computeNoteContentHash = (note: string) => crypto.createHash('sha256').update(note, 'utf8').digest('hex')

  const getNoteVectorConfig = () => {
    const row = db!
      .prepare(
        `SELECT embedding_model, embedding_dimensions, vector_table_name, updated_at FROM note_search_vector_config WHERE id = 1`
      )
      .get() as
      | {
          embedding_model?: string | null
          embedding_dimensions?: number | null
          vector_table_name?: string | null
          updated_at?: string | null
        }
      | undefined

    return {
      embedding_model: row?.embedding_model || null,
      embedding_dimensions: Number(row?.embedding_dimensions || 0),
      vector_table_name:
        typeof row?.vector_table_name === 'string' && row.vector_table_name.trim().length > 0
          ? row.vector_table_name.trim()
          : 'note_search_vec',
      updated_at: row?.updated_at || null,
    }
  }

  const ensureNoteVectorTable = (dimensions: number) => {
    if (!getSqliteVecAvailable()) {
      throw new Error(getSqliteVecLoadError() || 'sqlite-vec unavailable')
    }

    const normalizedDimensions = Math.max(0, Math.floor(Number(dimensions)))
    if (!normalizedDimensions) {
      throw new Error('embedding dimensions must be a positive integer')
    }

    const vectorConfig = getNoteVectorConfig()
    const vectorTableName = vectorConfig.vector_table_name

    if (vectorConfig.embedding_dimensions && vectorConfig.embedding_dimensions !== normalizedDimensions) {
      throw new Error(
        `Existing note vector dimensions (${vectorConfig.embedding_dimensions}) do not match requested dimensions (${normalizedDimensions})`
      )
    }

    db!.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName} USING vec0(
        message_id TEXT PRIMARY KEY,
        embedding float[${normalizedDimensions}],
        user_id TEXT partition key,
        project_id TEXT,
        storage_mode TEXT,
        conversation_id TEXT,
        note_updated_at TEXT
      );
    `)

    db!
      .prepare(
        `
        UPDATE note_search_vector_config
        SET embedding_dimensions = ?,
            vector_table_name = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `
      )
      .run(normalizedDimensions, vectorTableName)

    return { ...getNoteVectorConfig(), embedding_dimensions: normalizedDimensions }
  }

  const getNoteVectorStatus = () => {
    const vectorConfig = getNoteVectorConfig()
    return {
      available: getSqliteVecAvailable(),
      error: getSqliteVecLoadError(),
      embedding_model: vectorConfig.embedding_model,
      embedding_dimensions: vectorConfig.embedding_dimensions || null,
      vector_table_name: vectorConfig.vector_table_name,
      configured: getSqliteVecAvailable() && vectorConfig.embedding_dimensions > 0,
    }
  }

  const upsertNoteEmbedding = (params: {
    messageId: string
    embedding: unknown
    embeddingModel?: string
    expectedUserId?: string
  }) => {
    const embedding = normalizeEmbeddingInput(params.embedding)
    if (embedding.length === 0) {
      throw new Error('embedding must be a non-empty numeric array')
    }

    const vectorConfig = ensureNoteVectorTable(embedding.length)
    const doc = db!
      .prepare(
        `
        SELECT
          message_id,
          conversation_id,
          project_id,
          user_id,
          storage_mode,
          note,
          note_updated_at
        FROM note_search_docs
        WHERE message_id = ?
      `
      )
      .get(params.messageId) as
      | {
          message_id: string
          conversation_id: string
          project_id: string | null
          user_id: string
          storage_mode: string
          note: string
          note_updated_at: string
        }
      | undefined

    if (!doc) {
      throw new Error('note search document not found for message_id')
    }

    if (params.expectedUserId && doc.user_id !== params.expectedUserId) {
      throw new Error('note search document does not belong to expected user')
    }

    const contentHash = computeNoteContentHash(doc.note || '')
    db!
      .prepare(
        `
        INSERT OR REPLACE INTO ${vectorConfig.vector_table_name} (
          message_id,
          embedding,
          user_id,
          project_id,
          storage_mode,
          conversation_id,
          note_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        doc.message_id,
        JSON.stringify(embedding),
        doc.user_id,
        doc.project_id,
        doc.storage_mode,
        doc.conversation_id,
        doc.note_updated_at
      )

    db!
      .prepare(
        `
        INSERT INTO note_search_embedding_state (
          message_id,
          content_hash,
          embedding_model,
          embedding_dimensions,
          embedding_updated_at,
          embedding_status,
          last_error
        ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'ready', NULL)
        ON CONFLICT(message_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          embedding_model = excluded.embedding_model,
          embedding_dimensions = excluded.embedding_dimensions,
          embedding_updated_at = CURRENT_TIMESTAMP,
          embedding_status = 'ready',
          last_error = NULL
      `
      )
      .run(doc.message_id, contentHash, params.embeddingModel || null, embedding.length)

    if (params.embeddingModel) {
      db!
        .prepare(
          `UPDATE note_search_vector_config SET embedding_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
        )
        .run(params.embeddingModel)
    }

    return {
      message_id: doc.message_id,
      conversation_id: doc.conversation_id,
      embedding_dimensions: embedding.length,
      embedding_model: params.embeddingModel || null,
      content_hash: contentHash,
    }
  }

  const markNoteEmbeddingState = (params: {
    messageId: string
    status: 'pending' | 'ready' | 'error' | 'stale'
    error?: string | null
    embeddingModel?: string | null
    embeddingDimensions?: number | null
  }) => {
    db!
      .prepare(
        `
        INSERT INTO note_search_embedding_state (
          message_id,
          embedding_model,
          embedding_dimensions,
          embedding_updated_at,
          embedding_status,
          last_error
        ) VALUES (?, ?, ?, CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          embedding_model = COALESCE(excluded.embedding_model, note_search_embedding_state.embedding_model),
          embedding_dimensions = COALESCE(excluded.embedding_dimensions, note_search_embedding_state.embedding_dimensions),
          embedding_updated_at = CASE WHEN excluded.embedding_status = 'ready' THEN CURRENT_TIMESTAMP ELSE note_search_embedding_state.embedding_updated_at END,
          embedding_status = excluded.embedding_status,
          last_error = excluded.last_error
      `
      )
      .run(
        params.messageId,
        params.embeddingModel || null,
        params.embeddingDimensions || null,
        params.status,
        params.status,
        params.error || null
      )
  }

  const deleteNoteEmbedding = (messageId: string) => {
    const vectorConfig = getNoteVectorConfig()
    if (getSqliteVecAvailable() && vectorConfig.embedding_dimensions > 0) {
      try {
        db!.prepare(`DELETE FROM ${vectorConfig.vector_table_name} WHERE message_id = ?`).run(messageId)
      } catch (error) {
        console.warn('[LocalServer] Failed to delete note embedding row:', error)
      }
    }
    db!.prepare(`DELETE FROM note_search_embedding_state WHERE message_id = ?`).run(messageId)
  }

  const backfillNoteEmbeddings = async (params: {
    userId: string
    projectId?: string
    model?: string
    baseUrl?: string
    batchSize?: number
    limit?: number
    includeStatuses?: Array<'pending' | 'stale' | 'error'>
  }) => {
    const includeStatuses = Array.isArray(params.includeStatuses) && params.includeStatuses.length > 0
      ? params.includeStatuses.filter(status => ['pending', 'stale', 'error'].includes(status))
      : ['pending', 'stale', 'error']

    if (includeStatuses.length === 0) {
      throw new Error('includeStatuses must contain at least one of pending, stale, error')
    }

    const batchSize = Math.min(Math.max(Math.floor(Number(params.batchSize || 8)), 1), 32)
    const limit = Math.min(Math.max(Math.floor(Number(params.limit || 50)), 1), 500)
    const placeholders = includeStatuses.map(() => '?').join(', ')
    const whereProject = params.projectId ? 'AND d.project_id = ?' : ''

    const rows = db!
      .prepare(
        `
        SELECT
          d.message_id,
          d.conversation_id,
          d.project_id,
          d.user_id,
          d.note,
          d.note_updated_at,
          s.embedding_status,
          s.embedding_model,
          s.embedding_dimensions,
          s.content_hash,
          s.last_error
        FROM note_search_docs d
        INNER JOIN note_search_embedding_state s ON s.message_id = d.message_id
        WHERE d.user_id = ?
          ${whereProject}
          AND s.embedding_status IN (${placeholders})
        ORDER BY
          CASE s.embedding_status
            WHEN 'error' THEN 0
            WHEN 'stale' THEN 1
            ELSE 2
          END,
          datetime(d.note_updated_at) DESC
        LIMIT ?
      `
      )
      .all(
        params.userId,
        ...(params.projectId ? [params.projectId] : []),
        ...includeStatuses,
        limit
      ) as Array<{
        message_id: string
        conversation_id: string
        project_id: string | null
        user_id: string
        note: string
        note_updated_at: string
        embedding_status: 'pending' | 'stale' | 'error' | 'ready'
        embedding_model?: string | null
        embedding_dimensions?: number | null
        content_hash?: string | null
        last_error?: string | null
      }>

    if (rows.length === 0) {
      return {
        processed: 0,
        embedded: 0,
        failed: 0,
        skipped: 0,
        dimensions: getNoteVectorConfig().embedding_dimensions || null,
        model: params.model || getNoteVectorConfig().embedding_model || null,
        results: [] as Array<any>,
      }
    }

    const results: Array<any> = []
    let embedded = 0
    let failed = 0
    let skipped = 0
    let dimensions: number | null = getNoteVectorConfig().embedding_dimensions || null
    let resolvedModel: string | null = params.model || getNoteVectorConfig().embedding_model || null

    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize)
      const validBatch = batch.filter(row => typeof row.note === 'string' && row.note.trim().length > 0)

      for (const row of batch) {
        if (!validBatch.includes(row)) {
          skipped += 1
          results.push({
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            status: 'skipped',
            reason: 'empty_note',
          })
        }
      }

      if (validBatch.length === 0) continue

      try {
        const embeddingResult = await embedTextsWithLmStudio({
          inputs: validBatch.map(row => row.note),
          model: params.model,
          inputType: 'document',
          baseUrl: params.baseUrl,
        })

        dimensions = embeddingResult.dimensions
        resolvedModel = embeddingResult.model

        for (let batchIndex = 0; batchIndex < validBatch.length; batchIndex += 1) {
          const row = validBatch[batchIndex]
          try {
            const upsertResult = upsertNoteEmbedding({
              messageId: row.message_id,
              embedding: embeddingResult.embeddings[batchIndex],
              embeddingModel: embeddingResult.model,
              expectedUserId: params.userId,
            })

            embedded += 1
            results.push({
              message_id: row.message_id,
              conversation_id: row.conversation_id,
              status: 'ready',
              embedding_dimensions: upsertResult.embedding_dimensions,
              embedding_model: upsertResult.embedding_model,
            })
          } catch (error) {
            failed += 1
            const message = error instanceof Error ? error.message : 'Failed to upsert note embedding'
            markNoteEmbeddingState({
              messageId: row.message_id,
              status: 'error',
              error: message,
              embeddingModel: embeddingResult.model,
              embeddingDimensions: embeddingResult.dimensions,
            })
            results.push({
              message_id: row.message_id,
              conversation_id: row.conversation_id,
              status: 'error',
              error: message,
            })
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate embeddings from LM Studio'
        failed += validBatch.length
        for (const row of validBatch) {
          markNoteEmbeddingState({
            messageId: row.message_id,
            status: 'error',
            error: message,
            embeddingModel: params.model || null,
            embeddingDimensions: dimensions,
          })
          results.push({
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            status: 'error',
            error: message,
          })
        }
      }
    }

    return {
      processed: rows.length,
      embedded,
      failed,
      skipped,
      dimensions,
      model: resolvedModel,
      results,
    }
  }

  const vectorSearchNotes = (params: {
    userId: string
    queryEmbedding: unknown
    projectId?: string
    limit: number
  }) => {
    if (!getSqliteVecAvailable()) return [] as Array<any>

    const queryEmbedding = normalizeEmbeddingInput(params.queryEmbedding)
    if (queryEmbedding.length === 0) {
      throw new Error('query embedding must be a non-empty numeric array')
    }

    const vectorConfig = getNoteVectorConfig()
    if (!vectorConfig.embedding_dimensions) {
      throw new Error('note vector search is not configured yet')
    }
    if (vectorConfig.embedding_dimensions !== queryEmbedding.length) {
      throw new Error(
        `query embedding dimensions (${queryEmbedding.length}) do not match configured dimensions (${vectorConfig.embedding_dimensions})`
      )
    }

    const whereProject = params.projectId ? 'AND project_id = ?' : ''
    const rows = db!
      .prepare(
        `
        SELECT
          message_id,
          conversation_id,
          project_id,
          storage_mode,
          note_updated_at,
          distance
        FROM ${vectorConfig.vector_table_name}
        WHERE embedding MATCH ?
          AND k = ?
          AND user_id = ?
          ${whereProject}
        ORDER BY distance
      `
      )
      .all(
        JSON.stringify(queryEmbedding),
        Math.max(params.limit, 1),
        params.userId,
        ...(params.projectId ? [params.projectId] : [])
      ) as Array<any>

    return rows
  }

  const clampNoteSearchScore = (value: number, min: number = 0, max: number = 1) =>
    Math.min(max, Math.max(min, value))

  const getNoteSearchLexicalSignals = (params: {
    queryTokens: string[]
    normalizedQuery: string
    conversationTitle: string | null
    note: string
  }) => {
    const normalizedTitle = normalizeSearchText(params.conversationTitle || '')
    const normalizedText = normalizeSearchText(`${params.conversationTitle || ''} ${params.note || ''}`)
    const candidateTokens = Array.from(new Set(normalizedText.split(' ').filter(Boolean))).slice(0, 160)
    const candidateTokenSet = new Set(candidateTokens)
    const titleTokenSet = new Set(normalizedTitle.split(' ').filter(Boolean))

    let exactTokenMatches = 0
    let partialTokenMatches = 0
    let titleExactTokenMatches = 0

    for (const token of params.queryTokens) {
      if (candidateTokenSet.has(token)) {
        exactTokenMatches += 1
      } else if (candidateTokens.some(candidateToken => candidateToken.includes(token) || token.includes(candidateToken))) {
        partialTokenMatches += 1
      }

      if (titleTokenSet.has(token)) {
        titleExactTokenMatches += 1
      }
    }

    const phraseMatch = Boolean(params.normalizedQuery && normalizedText.includes(params.normalizedQuery))
    const exactCoverage = params.queryTokens.length > 0 ? exactTokenMatches / params.queryTokens.length : 0
    const partialCoverage =
      params.queryTokens.length > 0 ? Math.min(1, (exactTokenMatches + partialTokenMatches) / params.queryTokens.length) : 0

    const lexicalBoost = clampNoteSearchScore(
      (phraseMatch ? 0.32 : 0) +
        exactCoverage * 0.55 +
        exactTokenMatches * 0.08 +
        Math.max(partialCoverage - exactCoverage, 0) * 0.16 +
        Math.min(titleExactTokenMatches, 2) * 0.05,
      0,
      1.25
    )

    return {
      exact_token_matches: exactTokenMatches,
      partial_token_matches: partialTokenMatches,
      title_exact_token_matches: titleExactTokenMatches,
      exact_coverage: exactCoverage,
      partial_coverage: partialCoverage,
      phrase_match: phraseMatch,
      lexical_boost: lexicalBoost,
    }
  }

  const getNoteSearchVectorPenaltyFactor = (params: {
    queryTokens: string[]
    exactCoverage: number
    partialCoverage: number
    phraseMatch: boolean
  }) => {
    if (params.phraseMatch || params.queryTokens.length === 0 || params.queryTokens.length > 6) {
      return 1
    }

    if (params.exactCoverage >= 0.5) {
      return 1
    }

    if (params.exactCoverage > 0) {
      return 0.88
    }

    if (params.partialCoverage > 0) {
      return 0.68
    }

    return 0.42
  }

  const searchNotes = (params: {
    userId: string
    query: string
    projectId?: string
    limit: number
    queryEmbedding?: unknown
    vectorWeight?: number
    lexicalWeight?: number
    recencyWeight?: number
  }) => {
    const {
      userId,
      query,
      projectId,
      limit,
      queryEmbedding,
      vectorWeight = 0.45,
      lexicalWeight = 0.45,
      recencyWeight = 0.1,
    } = params
    const trimmedQuery = query.trim()
    const queryTokens = splitSearchTokens(trimmedQuery)
    const normalizedQuery = normalizeSearchText(trimmedQuery)

    type NoteSearchSourceType = 'fts' | 'fuzzy' | 'vector'
    type NoteSearchMatchType = NoteSearchSourceType | 'hybrid'

    type NoteSearchCandidate = {
      message_id: string
      conversation_id: string
      project_id: string | null
      storage_mode: 'cloud' | 'local'
      conversation_title: string | null
      message_created_at: string
      note_updated_at: string
      note: string
      match_type: NoteSearchMatchType
      source_match_types?: NoteSearchSourceType[]
      relevance: number
      vector_distance?: number | null
      lexical_score?: number | null
      vector_score?: number | null
      recency_score?: number | null
      exact_token_matches?: number
      partial_token_matches?: number
      exact_token_coverage?: number
      token_coverage?: number
      phrase_match?: boolean
    }

    const candidateMap = new Map<string, NoteSearchCandidate>()
    const scopeClause = projectId ? ' AND project_id = ?' : ''
    const scopeParams = projectId ? [userId, projectId] : [userId]

    const pushCandidate = (candidate: NoteSearchCandidate) => {
      const existing = candidateMap.get(candidate.message_id)
      if (!existing) {
        candidateMap.set(candidate.message_id, {
          ...candidate,
          source_match_types:
            candidate.source_match_types || (candidate.match_type === 'hybrid' ? [] : [candidate.match_type as NoteSearchSourceType]),
        })
        return
      }

      const existingTypes = existing.source_match_types || (existing.match_type === 'hybrid' ? [] : [existing.match_type as NoteSearchSourceType])
      const candidateTypes =
        candidate.source_match_types || (candidate.match_type === 'hybrid' ? [] : [candidate.match_type as NoteSearchSourceType])
      const mergedTypes = Array.from(new Set([...existingTypes, ...candidateTypes]))

      const existingVectorDistance = typeof existing.vector_distance === 'number' ? existing.vector_distance : null
      const candidateVectorDistance = typeof candidate.vector_distance === 'number' ? candidate.vector_distance : null

      candidateMap.set(candidate.message_id, {
        ...existing,
        relevance: Math.max(existing.relevance, candidate.relevance),
        lexical_score: Math.max(existing.lexical_score ?? 0, candidate.lexical_score ?? 0) || undefined,
        vector_score: Math.max(existing.vector_score ?? 0, candidate.vector_score ?? 0) || undefined,
        vector_distance:
          existingVectorDistance === null
            ? candidateVectorDistance
            : candidateVectorDistance === null
              ? existingVectorDistance
              : Math.min(existingVectorDistance, candidateVectorDistance),
        source_match_types: mergedTypes,
      })
    }

    if (queryEmbedding !== undefined && queryEmbedding !== null) {
      try {
        const vectorRows = vectorSearchNotes({
          userId,
          queryEmbedding,
          projectId,
          limit: Math.max(limit, NOTE_SEARCH_VECTOR_CANDIDATE_LIMIT),
        })

        for (const row of vectorRows) {
          const doc = db!
            .prepare(
              `
              SELECT
                message_id,
                conversation_id,
                project_id,
                storage_mode,
                conversation_title,
                message_created_at,
                note_updated_at,
                note
              FROM note_search_docs
              WHERE message_id = ?
            `
            )
            .get(String(row.message_id)) as
            | {
                message_id: string
                conversation_id: string
                project_id: string | null
                storage_mode: string
                conversation_title: string | null
                message_created_at: string
                note_updated_at: string
                note: string
              }
            | undefined

          if (!doc) continue

          const distanceValue = Number(row.distance)
          const vectorScore = Number.isFinite(distanceValue) ? 1 / (1 + Math.max(distanceValue, 0)) : 0

          pushCandidate({
            message_id: doc.message_id,
            conversation_id: doc.conversation_id,
            project_id: doc.project_id || null,
            storage_mode: doc.storage_mode === 'cloud' ? 'cloud' : 'local',
            conversation_title: doc.conversation_title || null,
            message_created_at: doc.message_created_at,
            note_updated_at: doc.note_updated_at,
            note: doc.note || '',
            match_type: 'vector',
            relevance: vectorScore,
            vector_distance: Number.isFinite(distanceValue) ? distanceValue : null,
            vector_score: vectorScore,
          })
        }
      } catch (vectorSearchError) {
        console.warn('[LocalServer] Note vector search failed, continuing with lexical search only:', vectorSearchError)
      }
    }

    const tryRunFts = (ftsQuery: string) => {
      if (!ftsQuery) return

      const rows = db!
        .prepare(
          `
          SELECT
            d.message_id,
            d.conversation_id,
            d.project_id,
            d.storage_mode,
            d.conversation_title,
            d.message_created_at,
            d.note_updated_at,
            d.note,
            bm25(note_search_fts) AS fts_rank
          FROM note_search_fts
          INNER JOIN note_search_docs d ON d.message_id = note_search_fts.message_id
          WHERE note_search_fts MATCH ?
            AND d.user_id = ?
            ${scopeClause}
          ORDER BY fts_rank ASC, datetime(d.note_updated_at) DESC, datetime(d.message_created_at) DESC
          LIMIT ?
        `
        )
        .all(ftsQuery, ...scopeParams, NOTE_SEARCH_FTS_CANDIDATE_LIMIT) as Array<any>

      for (const row of rows) {
        const normalizedText = normalizeSearchText(`${row.conversation_title || ''} ${row.note || ''}`)
        const rank = Number.isFinite(Number(row.fts_rank)) ? Math.max(Number(row.fts_rank), 0) : 10
        const rankBoost = 1 / (1 + rank)
        const containsBoost = normalizedQuery && normalizedText.includes(normalizedQuery) ? 0.12 : 0
        const lexicalScore = 0.74 + rankBoost * 0.18 + containsBoost

        pushCandidate({
          message_id: String(row.message_id),
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          message_created_at: row.message_created_at,
          note_updated_at: row.note_updated_at,
          note: row.note || '',
          match_type: 'fts',
          relevance: lexicalScore,
          lexical_score: lexicalScore,
        })
      }
    }

    if (queryTokens.length > 0) {
      try {
        tryRunFts(buildStrictFtsQuery(queryTokens))
      } catch {
        // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
      }

      if (candidateMap.size < limit * 2) {
        try {
          tryRunFts(buildRelaxedFtsQuery(queryTokens))
        } catch {
          // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
        }
      }
    }

    if (candidateMap.size < limit * 2) {
      const recentRows = db!
        .prepare(
          `
          SELECT
            message_id,
            conversation_id,
            project_id,
            storage_mode,
            conversation_title,
            message_created_at,
            note_updated_at,
            note
          FROM note_search_docs
          WHERE user_id = ?
            ${scopeClause}
          ORDER BY datetime(note_updated_at) DESC, datetime(message_created_at) DESC
          LIMIT ?
        `
        )
        .all(...scopeParams, NOTE_SEARCH_FUZZY_CANDIDATE_LIMIT) as Array<any>

      const fuzzyThreshold = normalizedQuery.length <= 5 ? 0.78 : 0.64

      for (const row of recentRows) {
        const messageId = String(row.message_id)
        if (candidateMap.has(messageId)) continue

        const fuzzyRelevance = calculateFuzzyRelevance(
          trimmedQuery,
          `${row.conversation_title || ''} ${row.note || ''}`,
          row.note || null
        )
        if (fuzzyRelevance < fuzzyThreshold) continue

        const lexicalScore = clampNoteSearchScore(fuzzyRelevance, 0, 1.05)

        pushCandidate({
          message_id: messageId,
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          message_created_at: row.message_created_at,
          note_updated_at: row.note_updated_at,
          note: row.note || '',
          match_type: 'fuzzy',
          relevance: lexicalScore,
          lexical_score: lexicalScore,
        })
      }
    }

    const now = Date.now()
    const maxAgeMs = 180 * 24 * 60 * 60 * 1000

    const scoredCandidates = Array.from(candidateMap.values())
      .map(candidate => {
        const lexicalSignals = getNoteSearchLexicalSignals({
          queryTokens,
          normalizedQuery,
          conversationTitle: candidate.conversation_title,
          note: candidate.note,
        })

        const baseLexicalScore = Math.max(candidate.lexical_score ?? 0, 0)
        const lexicalScore = clampNoteSearchScore(baseLexicalScore + lexicalSignals.lexical_boost, 0, 1.75)

        const rawVectorScore = Math.max(candidate.vector_score ?? 0, 0)
        const vectorPenaltyFactor =
          rawVectorScore > 0
            ? getNoteSearchVectorPenaltyFactor({
                queryTokens,
                exactCoverage: lexicalSignals.exact_coverage,
                partialCoverage: lexicalSignals.partial_coverage,
                phraseMatch: lexicalSignals.phrase_match,
              })
            : 1
        const vectorScore = rawVectorScore * vectorPenaltyFactor

        const updatedMs = new Date(candidate.note_updated_at || candidate.message_created_at).getTime()
        const ageMs = Number.isFinite(updatedMs) ? Math.max(now - updatedMs, 0) : maxAgeMs
        const recencyScore = candidate.recency_score ?? Math.max(0, 1 - ageMs / maxAgeMs)
        const combinedScore = vectorWeight * vectorScore + lexicalWeight * lexicalScore + recencyWeight * recencyScore

        const sourceMatchTypes =
          candidate.source_match_types || (candidate.match_type === 'hybrid' ? [] : [candidate.match_type as NoteSearchSourceType])
        const hasVectorSignal = vectorScore > 0 || sourceMatchTypes.includes('vector')
        const hasLexicalSignal = lexicalScore > 0
        const matchType: NoteSearchMatchType = hasVectorSignal && hasLexicalSignal
          ? 'hybrid'
          : hasVectorSignal
            ? 'vector'
            : sourceMatchTypes.includes('fts')
              ? 'fts'
              : 'fuzzy'

        return {
          ...candidate,
          match_type: matchType,
          source_match_types: sourceMatchTypes,
          lexical_score: lexicalScore,
          vector_score: vectorScore,
          recency_score: recencyScore,
          relevance: combinedScore,
          exact_token_matches: lexicalSignals.exact_token_matches,
          partial_token_matches: lexicalSignals.partial_token_matches,
          exact_token_coverage: lexicalSignals.exact_coverage,
          token_coverage: lexicalSignals.partial_coverage,
          phrase_match: lexicalSignals.phrase_match,
        }
      })
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance
        const aTime = new Date(a.note_updated_at || a.message_created_at).getTime()
        const bTime = new Date(b.note_updated_at || b.message_created_at).getTime()
        return bTime - aTime
      })

    const groupedByConversation = new Map<
      string,
      {
        best: NoteSearchCandidate
        conversation_hit_count: number
        matched_message_ids: string[]
        source_match_types: Set<NoteSearchSourceType>
      }
    >()

    for (const candidate of scoredCandidates) {
      const existing = groupedByConversation.get(candidate.conversation_id)
      const sourceTypes = candidate.source_match_types || []

      if (!existing) {
        groupedByConversation.set(candidate.conversation_id, {
          best: candidate,
          conversation_hit_count: 1,
          matched_message_ids: [candidate.message_id],
          source_match_types: new Set(sourceTypes),
        })
        continue
      }

      existing.conversation_hit_count += 1
      if (!existing.matched_message_ids.includes(candidate.message_id)) {
        existing.matched_message_ids.push(candidate.message_id)
      }
      for (const sourceType of sourceTypes) {
        existing.source_match_types.add(sourceType)
      }
    }

    return Array.from(groupedByConversation.values())
      .sort((a, b) => {
        if (b.best.relevance !== a.best.relevance) return b.best.relevance - a.best.relevance
        const aTime = new Date(a.best.note_updated_at || a.best.message_created_at).getTime()
        const bTime = new Date(b.best.note_updated_at || b.best.message_created_at).getTime()
        return bTime - aTime
      })
      .slice(0, limit)
      .map(group => ({
        conversation_id: group.best.conversation_id,
        project_id: group.best.project_id,
        storage_mode: group.best.storage_mode,
        conversation_title: group.best.conversation_title,
        message_id: group.best.message_id,
        message_created_at: group.best.message_created_at,
        note_updated_at: group.best.note_updated_at,
        note: buildMessageSnippet(group.best.note, trimmedQuery),
        match_type: group.best.match_type,
        source_match_types: Array.from(group.source_match_types),
        score: Number(group.best.relevance.toFixed(6)),
        lexical_score: Number((group.best.lexical_score || 0).toFixed(6)),
        vector_score: Number((group.best.vector_score || 0).toFixed(6)),
        recency_score: Number((group.best.recency_score || 0).toFixed(6)),
        vector_distance: group.best.vector_distance ?? null,
        conversation_hit_count: group.conversation_hit_count,
        matched_message_ids: group.matched_message_ids.slice(0, 5),
        why_matched: {
          exact_token_matches: group.best.exact_token_matches || 0,
          partial_token_matches: group.best.partial_token_matches || 0,
          exact_token_coverage: Number((group.best.exact_token_coverage || 0).toFixed(6)),
          token_coverage: Number((group.best.token_coverage || 0).toFixed(6)),
          phrase_match: Boolean(group.best.phrase_match),
        },
      }))
  }

  const searchTopLevelUserMessages = (params: {
    userId: string
    query: string
    projectId?: string
    limit: number
  }) => {
    const { userId, query, projectId, limit } = params
    const trimmedQuery = query.trim()
    const queryTokens = splitSearchTokens(trimmedQuery)
    const normalizedQuery = normalizeSearchText(trimmedQuery)

    const candidateMap = new Map<string, TopLevelMessageSearchCandidate>()
    const scopeClause = projectId ? ' AND c.project_id = ?' : ''
    const scopeParams = projectId ? [userId, projectId] : [userId]

    const pushCandidate = (candidate: TopLevelMessageSearchCandidate) => {
      const existing = candidateMap.get(candidate.message_id)
      if (!existing || candidate.relevance > existing.relevance) {
        candidateMap.set(candidate.message_id, candidate)
      }
    }

    const tryRunFts = (ftsQuery: string) => {
      if (!ftsQuery) return

      const ftsRows = db!
        .prepare(
          `
          SELECT
            m.id AS message_id,
            m.conversation_id AS conversation_id,
            c.project_id AS project_id,
            c.storage_mode AS storage_mode,
            c.title AS conversation_title,
            c.updated_at AS conversation_updated_at,
            m.created_at AS message_created_at,
            m.content AS message_content,
            m.plain_text_content AS message_plain_text_content,
            m.note AS message_note,
            bm25(top_level_user_message_search) AS fts_rank
          FROM top_level_user_message_search
          INNER JOIN messages m ON m.id = top_level_user_message_search.message_id
          INNER JOIN conversations c ON c.id = m.conversation_id
          WHERE top_level_user_message_search MATCH ?
            AND c.user_id = ?
            ${scopeClause}
          ORDER BY fts_rank ASC, datetime(COALESCE(c.updated_at, c.created_at)) DESC, datetime(m.created_at) DESC
          LIMIT ?
        `
        )
        .all(ftsQuery, ...scopeParams, TOP_LEVEL_MESSAGE_SEARCH_FTS_CANDIDATE_LIMIT) as Array<any>

      for (const row of ftsRows) {
        const messageText = row.message_plain_text_content || row.message_content || ''
        const normalizedText = normalizeSearchText(`${row.message_note || ''} ${messageText}`)
        const rank = Number.isFinite(Number(row.fts_rank)) ? Math.max(Number(row.fts_rank), 0) : 10
        const rankBoost = 1 / (1 + rank)
        const containsBoost = normalizedQuery && normalizedText.includes(normalizedQuery) ? 0.25 : 0

        pushCandidate({
          message_id: String(row.message_id),
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          conversation_updated_at: row.conversation_updated_at || null,
          message_created_at: row.message_created_at,
          message_content: row.message_content || '',
          message_plain_text_content: row.message_plain_text_content || null,
          message_note: row.message_note || null,
          match_type: 'fts',
          relevance: 2 + rankBoost + containsBoost,
        })
      }
    }

    if (queryTokens.length > 0) {
      try {
        tryRunFts(buildStrictFtsQuery(queryTokens))
      } catch {
        // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
      }

      if (candidateMap.size < limit) {
        try {
          tryRunFts(buildRelaxedFtsQuery(queryTokens))
        } catch {
          // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
        }
      }
    }

    if (candidateMap.size < limit) {
      const recentRows = db!
        .prepare(
          `
          SELECT
            m.id AS message_id,
            m.conversation_id AS conversation_id,
            c.project_id AS project_id,
            c.storage_mode AS storage_mode,
            c.title AS conversation_title,
            c.updated_at AS conversation_updated_at,
            m.created_at AS message_created_at,
            m.content AS message_content,
            m.plain_text_content AS message_plain_text_content,
            m.note AS message_note
          FROM messages m
          INNER JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ?
            ${scopeClause}
            AND m.parent_id IS NULL
            AND m.role = 'user'
          ORDER BY datetime(COALESCE(c.updated_at, c.created_at)) DESC, datetime(m.created_at) DESC
          LIMIT ?
        `
        )
        .all(...scopeParams, TOP_LEVEL_MESSAGE_SEARCH_FUZZY_CANDIDATE_LIMIT) as Array<any>

      const fuzzyThreshold = normalizedQuery.length <= 5 ? 0.78 : 0.64

      for (const row of recentRows) {
        const messageId = String(row.message_id)
        if (candidateMap.has(messageId)) continue

        const messageText = row.message_plain_text_content || row.message_content || ''
        const fuzzyRelevance = calculateFuzzyRelevance(trimmedQuery, messageText, row.message_note || null)
        if (fuzzyRelevance < fuzzyThreshold) continue

        pushCandidate({
          message_id: messageId,
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          conversation_updated_at: row.conversation_updated_at || null,
          message_created_at: row.message_created_at,
          message_content: row.message_content || '',
          message_plain_text_content: row.message_plain_text_content || null,
          message_note: row.message_note || null,
          match_type: 'fuzzy',
          relevance: fuzzyRelevance,
        })
      }
    }

    return Array.from(candidateMap.values())
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance
        const aConversationTime = new Date(a.conversation_updated_at || a.message_created_at).getTime()
        const bConversationTime = new Date(b.conversation_updated_at || b.message_created_at).getTime()
        if (bConversationTime !== aConversationTime) return bConversationTime - aConversationTime
        const aMessageTime = new Date(a.message_created_at).getTime()
        const bMessageTime = new Date(b.message_created_at).getTime()
        return bMessageTime - aMessageTime
      })
      .slice(0, limit)
      .map(candidate => {
        const messageText = candidate.message_plain_text_content || candidate.message_content || ''
        return {
          conversation_id: candidate.conversation_id,
          project_id: candidate.project_id,
          storage_mode: candidate.storage_mode,
          conversation_title: candidate.conversation_title,
          message_id: candidate.message_id,
          message_created_at: candidate.message_created_at,
          conversation_updated_at: candidate.conversation_updated_at,
          content: buildMessageSnippet(messageText, trimmedQuery),
          note: candidate.message_note,
          match_type: candidate.match_type,
          score: Number(candidate.relevance.toFixed(6)),
        }
      })
  }

  // GET /api/local/conversations/search?userId=xxx&q=term&limit=20&projectId=xxx
  app.get('/api/local/conversations/search', (req, res) => {
    try {
      const userId = req.query.userId as string
      const rawQuery = (req.query.q as string) || ''
      const projectId = (req.query.projectId as string | undefined) || undefined
      const rawLimit = Number(req.query.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const trimmedQuery = rawQuery.trim()
      const normalizedQuery = trimmedQuery.replace(/[\s_-]+/g, '')
      const likeQuery = `%${trimmedQuery}%`
      const normalizedLikeQuery = `%${normalizedQuery || trimmedQuery}%`
      const conversations = projectId
        ? statements.searchConversationsByTitleInProject.all(userId, projectId, likeQuery, normalizedLikeQuery, limit)
        : statements.searchConversationsByTitle.all(userId, likeQuery, normalizedLikeQuery, limit)

      res.json(conversations)
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching conversations by title:', error)
      res.status(500).json({ error: 'Failed to search conversations' })
    }
  })

  // GET /api/local/conversations/search/notes?userId=xxx&q=term&limit=20&projectId=xxx
  app.get('/api/local/conversations/search/notes', (req, res) => {
    try {
      const userId = req.query.userId as string
      const rawQuery = (req.query.q as string) || ''
      const projectId = (req.query.projectId as string | undefined) || undefined
      const rawLimit = Number(req.query.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)
      const queryEmbedding = req.query.embedding

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const results = searchNotes({
        userId,
        query: rawQuery,
        projectId,
        limit,
      })

      res.json({
        results,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching notes:', error)
      res.status(500).json({ error: 'Failed to search notes' })
    }
  })

  // POST /api/local/conversations/search/notes/search
  app.post('/api/local/conversations/search/notes/search', (req, res) => {
    try {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const rawQuery = typeof req.body?.q === 'string' ? req.body.q : ''
      const projectId = typeof req.body?.projectId === 'string' && req.body.projectId.trim().length > 0 ? req.body.projectId.trim() : undefined
      const rawLimit = Number(req.body?.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const results = searchNotes({
        userId,
        query: rawQuery,
        projectId,
        limit,
      })

      res.json({
        results,
        query: rawQuery,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching notes:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to search notes' })
    }
  })

  // GET /api/local/conversations/search/notes/vector-status
  app.get('/api/local/conversations/search/notes/vector-status', (_req, res) => {
    try {
      res.json(getNoteVectorStatus())
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching note vector status:', error)
      res.status(500).json({ error: 'Failed to fetch note vector status' })
    }
  })

  // POST /api/local/conversations/search/notes/configure-vector
  app.post('/api/local/conversations/search/notes/configure-vector', (req, res) => {
    try {
      const embeddingDimensions = Number(req.body?.embeddingDimensions)
      const embeddingModel = typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel.trim() : ''

      if (!Number.isFinite(embeddingDimensions) || embeddingDimensions <= 0) {
        res.status(400).json({ error: 'embeddingDimensions must be a positive integer' })
        return
      }

      const vectorConfig = ensureNoteVectorTable(embeddingDimensions)
      if (embeddingModel) {
        db!
          .prepare(`UPDATE note_search_vector_config SET embedding_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
          .run(embeddingModel)
      }

      res.json({
        success: true,
        sqlite_vec: getNoteVectorStatus(),
        vector_config: {
          ...vectorConfig,
          embedding_model: embeddingModel || vectorConfig.embedding_model,
        },
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error configuring note vector table:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to configure note vector table' })
    }
  })

  // POST /api/local/conversations/search/notes/upsert-embedding
  app.post('/api/local/conversations/search/notes/upsert-embedding', (req, res) => {
    try {
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
      const embedding = req.body?.embedding
      const embeddingModel = typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel.trim() : ''
      const expectedUserId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''

      if (!messageId) {
        res.status(400).json({ error: 'messageId required' })
        return
      }

      const result = upsertNoteEmbedding({
        messageId,
        embedding,
        embeddingModel: embeddingModel || undefined,
        expectedUserId: expectedUserId || undefined,
      })

      res.json({ success: true, result, sqlite_vec: getNoteVectorStatus() })
    } catch (error) {
      console.error('[LocalServer] ❌ Error upserting note embedding:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to upsert note embedding' })
    }
  })

  // POST /api/local/conversations/search/notes/mark-embedding-state
  app.post('/api/local/conversations/search/notes/mark-embedding-state', (req, res) => {
    try {
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
      const status = req.body?.status as 'pending' | 'ready' | 'error' | 'stale'

      if (!messageId) {
        res.status(400).json({ error: 'messageId required' })
        return
      }

      if (!['pending', 'ready', 'error', 'stale'].includes(status)) {
        res.status(400).json({ error: 'status must be one of pending, ready, error, stale' })
        return
      }

      markNoteEmbeddingState({
        messageId,
        status,
        error: typeof req.body?.error === 'string' ? req.body.error : null,
        embeddingModel: typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel : null,
        embeddingDimensions:
          req.body?.embeddingDimensions !== undefined ? Number(req.body.embeddingDimensions) : null,
      })

      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] ❌ Error marking note embedding state:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to mark note embedding state' })
    }
  })

  // POST /api/local/conversations/search/notes/embed
  app.post('/api/local/conversations/search/notes/embed', async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
      const inputTypeRaw = typeof req.body?.inputType === 'string' ? req.body.inputType.trim().toLowerCase() : ''
      const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
      const expectedUserId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const upsert = req.body?.upsert === true

      if (!text) {
        res.status(400).json({ error: 'text required' })
        return
      }

      const inputType = inputTypeRaw === 'query' || inputTypeRaw === 'document' ? inputTypeRaw : 'none'
      const embeddingResult = await embedTextWithLmStudio({
        text,
        model: model || undefined,
        inputType,
        baseUrl: baseUrl || undefined,
      })

      let upsertResult: ReturnType<typeof upsertNoteEmbedding> | null = null
      if (upsert) {
        if (!messageId) {
          res.status(400).json({ error: 'messageId required when upsert=true' })
          return
        }

        upsertResult = upsertNoteEmbedding({
          messageId,
          embedding: embeddingResult.embedding,
          embeddingModel: embeddingResult.model,
          expectedUserId: expectedUserId || undefined,
        })
      }

      res.json({
        success: true,
        model: embeddingResult.model,
        input_type: embeddingResult.inputType,
        dimensions: embeddingResult.dimensions,
        embedding: embeddingResult.embedding,
        upserted: upsert,
        upsert_result: upsertResult,
        lmstudio: {
          base_url: getLmStudioBaseUrl(baseUrl || undefined),
        },
        sqlite_vec: getNoteVectorStatus(),
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error generating note embedding with LM Studio:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate note embedding' })
    }
  })

  // POST /api/local/conversations/search/notes/backfill-missing
  app.post('/api/local/conversations/search/notes/backfill-missing', async (req, res) => {
    try {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : ''
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
      const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
      const batchSize = req.body?.batchSize !== undefined ? Number(req.body.batchSize) : undefined
      const limit = req.body?.limit !== undefined ? Number(req.body.limit) : undefined
      const includeStatuses = Array.isArray(req.body?.includeStatuses) ? req.body.includeStatuses : undefined

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      const result = await backfillNoteEmbeddings({
        userId,
        projectId: projectId || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        batchSize,
        limit,
        includeStatuses,
      })

      res.json({
        success: true,
        result,
        lmstudio: {
          base_url: getLmStudioBaseUrl(baseUrl || undefined),
        },
        sqlite_vec: getNoteVectorStatus(),
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error backfilling note embeddings with LM Studio:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to backfill note embeddings' })
    }
  })

  // GET /api/local/conversations/search/top-level-users?userId=xxx&q=term&limit=20&projectId=xxx
  app.get('/api/local/conversations/search/top-level-users', (req, res) => {
    try {
      const userId = req.query.userId as string
      const rawQuery = (req.query.q as string) || ''
      const projectId = (req.query.projectId as string | undefined) || undefined
      const rawLimit = Number(req.query.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const results = searchTopLevelUserMessages({
        userId,
        query: rawQuery,
        projectId,
        limit,
      })

      res.json(results)
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching top-level user messages:', error)
      res.status(500).json({ error: 'Failed to search top-level user messages' })
    }
  })

  return { searchNotes, searchTopLevelUserMessages }
}
