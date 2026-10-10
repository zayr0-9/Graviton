# SQLite schema migrations

Last reviewed: 2026-09-29

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

## Verifying a migration

```bash
# Inspect the stamped version and the columns of a database copy
sqlite3 /path/to/local-sync.db 'PRAGMA user_version; PRAGMA table_info(conversations);'
```

Start the server once against a copy of a pre-migration database. The log prints
`[LocalServer] Applied schema migration v<N> (<name>)` once, and never again on the next start.
