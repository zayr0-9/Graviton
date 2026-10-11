# SQLite schema migrations

Last reviewed: 2026-10-11

The local database (`<dataDir>/local-sync.db`) is upgraded on every server start by
`runSchemaMigrations()` in `server/localServer.ts`. The runner reads SQLite's
`PRAGMA user_version`, applies every entry of `SCHEMA_MIGRATIONS` with a higher
`version` in ascending order, and stamps `user_version` after each successful `up`.
An installed app therefore upgrades itself once per migration and never re-runs one.

## Rules

1. **Two places, one PR.** Change the `CREATE TABLE ... IF NOT EXISTS` block so a fresh
   database gets the final shape, and append a migration so an existing database
   reaches the same shape. Fresh and upgraded installs must converge.
2. **Append only.** Take the next integer `version`. Never edit, renumber, or delete a
   shipped migration.
3. **Idempotent `up`.** Guard `ALTER TABLE ... ADD COLUMN` with a `PRAGMA table_info`
   check. Use `CREATE ... IF NOT EXISTS` for tables and indexes. A crash between the DDL
   and the stamp must be harmless on the next launch.
4. **No data rewrites in `up` without a guard.** A backfill must be safe to run twice.
5. **Record it here.** Add a row to the log below in the same change, with the version,
   the name used in code, what changed, and why.
6. **Readers tolerate both shapes.** Code that reads a new column must accept `NULL`
   from rows written before the migration.

## Log

| Version | Name | Change | Why | Added |
| --- | --- | --- | --- | --- |
| 1 | `subagent_manager_columns` | `subagent_runs` gains `handle`, `attempt`, `last_turn_at` and two indexes. | Subagent manager (detached runs, resume). | before 2026-09-15 |
| 2 | `messages_meta_column` | `messages` gains `meta TEXT` (JSON object). First key: `kind = 'context_injection'` with `files` and `reason`. | Auto-loaded instruction files are persisted as tagged user rows (docs/claude_code_context_loading_rules.md §11.3 decision 6). Future per-message identifiers go in `meta`, not in new columns. | 2026-09-15 |
| 3 | `hook_runs` | Adds operational hook-run lifecycle records and indexes by message, conversation, stream, and active status. | Async hook completion, skips, failures, and diagnostics must survive SSE completion and app navigation. | 2026-09-16 |
| 4 | `conversation_additional_cwds` | `conversations` gains nullable `additional_cwds TEXT` containing a JSON array of directory strings; `cwd` is unchanged. | Add storage for extra conversation roots without changing the existing default-directory contract. | 2026-09-29 |
| 5 | `search_index_rowid_rebuild` | Rebuilds `top_level_user_message_search` and `note_search_fts` once, keyed by the base-table rowid; syncs `note_search_docs` and `note_search_embedding_state` while keeping `note_updated_at` for unchanged notes; replaces all 11 search triggers. | Boot used to empty and refill both indexes and recreate 7 triggers on every launch (one full `messages` scan, and every `note_updated_at` reset to the boot time). Trigger deletes by `message_id` scanned the whole FTS index. | 2026-10-11 |

## Conversation directory storage (v4)

- `cwd` remains a single default working-directory path (or `NULL`).
- `additional_cwds` stores JSON text, for example `["/projects/backend", "/projects/shared"]`.
- `NULL` means no additional directories, equivalent to `[]` for readers. Existing
  rows are not rewritten; their `cwd` values and all other fields are preserved.
- Fresh databases declare the column in `CREATE TABLE conversations`. Existing
  databases add it through the startup `runSchemaMigrations()` runner. The v4
  migration checks `PRAGMA table_info(conversations)` before adding the column,
  so it is safe if the column already exists. `PRAGMA user_version` prevents
  reapplying completed migrations on subsequent launches.
- This migration adds storage only. API serialization/validation, UI selection,
  multi-root context loading, and tool-path authorization are separate follow-up
  work. The existing single-root execution behavior is unchanged. This is a local
  SQLite migration, not a migration of the external cloud database.

## Search index maintenance (v5)

- Boot runs only `TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL` (`server/topLevelUserMessages.ts`)
  and the `NOTE_SEARCH_*_SQL` constants (`server/searchIndexSchema.ts`). Every statement
  is `CREATE ... IF NOT EXISTS`. Boot never deletes or refills index rows.
- The triggers keep both indexes current. `CREATE TRIGGER IF NOT EXISTS` never replaces
  an existing body, so a trigger change ships as a new migration whose `up` calls
  `rebuildSearchIndexes(database)`. That function is idempotent and runs in a savepoint.
- FTS rows use the rowid of `messages` (top-level index) or `note_search_docs` (note
  index), because FTS5 scans the whole index for `WHERE message_id = ?` and does a
  lookup for `WHERE rowid = ?`. Both base tables have TEXT primary keys, so `VACUUM` may
  renumber their rowids. Nothing runs `VACUUM` today; if that changes, call
  `rebuildSearchIndexes` afterwards.
- `note_updated_at` changes only when the note text changes. Title, project, user, and
  storage-mode changes update the denormalised doc columns and keep the timestamp.
  `updated_at` touches on `conversations` do nothing.
- Top-level index triggers fire only for user rows whose parent is a root or a generated
  (context-injection / access-notice) row. Follow-up turns, assistant and tool rows,
  streaming content updates, and `children_ids` maintenance cost nothing.
- Verify on a copy before and after one start:
  `sqlite3 copy.db "SELECT COUNT(*) FROM top_level_user_message_search; SELECT COUNT(*), COUNT(DISTINCT note_updated_at) FROM note_search_docs;"`.

## Verifying a migration

```bash
# Inspect the stamped version and the columns of a database copy
sqlite3 /path/to/local-sync.db 'PRAGMA user_version; PRAGMA table_info(conversations);'
```

Start the server once against a copy of a pre-migration database. The log prints
`[LocalServer] Applied schema migration v<N> (<name>)` once, and never again on the next start.
