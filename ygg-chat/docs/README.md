---
paths:
  - "docs/**"
---

# Documentation and context rules

Start with [the agent context index](agent_context/AGENT.md), then read the smallest
relevant subsystem guide. This directory remains the canonical documentation source.

## Frontmatter contract

Use the same path-scoped rule format as Vega's `ai/cli/.claude/rules/`:

```yaml
---
paths:
  - "client/ygg-chat-r/server/context/**"
  - "shared/contextDirectories.ts"
  - "shared/contextInjection.ts"
---
```

- Put the opening `---` on line 1 and a blank line after the closing delimiter.
- Use a non-empty YAML list of quoted strings. Quote globs, especially those containing
  `*` or `{a,b}`. Do not use comma-separated strings for brace patterns.
- Paths are relative to **`ygg-chat/`**, the project/conversation root for this context
  set, not to `docs/`, the client package, or the parent `Graviton/` Git root.
- Match the subsystem's source entrypoints and dedicated directories. Use `**` for a
  whole subsystem and exact paths for shared integration points. Avoid catch-all
  `**/*`, `client/**`, or `shared/**` scopes on specialized guides.
- `paths` is the rule-routing field. Skill/agent fields such as `name`, `description`,
  and `allowed-tools` are not required for these docs; `alwaysApply` is not part of
  this rule contract.
- An absent or empty `paths` list is unconditional in Graviton. Do not use an empty
  list to mean "disabled". Documentation-only references match their own doc paths.
- Keep the body focused on responsibilities, source entrypoints, invariants, gotchas,
  and validation. Change it when a documented fact changes, not for every refactor.
- When files move, update the covering patterns with the source change. Check that
  every pattern still matches an intended file.

## Discovery is separate from frontmatter

Adding metadata here does **not** register these files for automatic loading. Claude
Code discovers rules under `.claude/rules/`; Graviton discovers them under
`<readDir>/rules/` (normally `.ygg/rules/` and `.claude/rules/`). Setting a read directory
to `docs` alone would look for `docs/rules/`, not this directory's Markdown files.

If you want automatic loading, an optional, single-source setup from `ygg-chat/` is:

```bash
mkdir -p .claude/rules
ln -s ../../docs .claude/rules/docs
```

Only create this link if `.claude/rules/docs` does not already exist. Keep `.claude`
in Graviton's context read directories and use `ygg-chat/` as the conversation root.
The link stays inside that root; do not register a second copy under `.ygg/rules/`.
This setup is **not applied** by the frontmatter-only documentation change.

Do not eagerly import every doc into `CLAUDE.md` or `AGENTS.md`: imports load their
bodies immediately rather than waiting for a matching source path. Keep the index
available and let the rule loader select subsystem guides on demand. The existing
singular `agent_context/AGENT.md` is an index, not an automatically discovered
`AGENTS.md` instruction file.

For implementation details, see [context loading](agent_context/agent_context_loading.md).
The longer [Claude Code reference](claude_code_context_loading_rules.md) records the
loading contract; it is not a general-purpose launch instruction.
