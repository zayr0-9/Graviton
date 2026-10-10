---
paths:
  - "docs/source-doc-audit.md"
---

# Documentation-to-source audit

## Scope

Reviewed all 41 documents present in `docs/` at audit start against current on-disk
source, including uncommitted changes. Six read-only reviewers covered tools,
chat/branch/storage, integrations, server/auth/hooks/subagents, context loading,
and UI design. A seventh reviewer checked the corrected core runtime guides.
The parent applied all edits; reviewers changed no files.

This is a static source audit, not a certification of runtime behavior or live
Claude Code parity. The dated upstream reference retains its original fetch dates.
Application source, existing user changes, and the untracked read-file guide were
not replaced or reverted.

## Main corrections

- Moved active implementation references from `electron/` to `server/`, while
  preserving clearly historical deleted-file references.
- Documented canonical auth ownership, four gateway flags, resolved server origins,
  and the existing standalone host without expanding desktop support policy.
- Corrected cancellation frames, detach/reattach, permission denial, eight hook
  events, and transcript context placement.
- Aligned snapshot loading, durable lineage/schema, SSE projection, error-block
  exclusions, and stream-keyed decisions with source.
- Corrected tool parameters/payloads, workspace/symlink safety claims, and helper
  versus model-visible schema distinctions.
- Updated agents-pill motion, apps-action visibility, history counts, themes, and
  separate global error notices.
- Qualified implemented context-loading behavior instead of claiming complete
  Claude parity.

## Source discrepancies retained for separate implementation work

Documentation now describes these limitations; no source fixes were made:

1. **Iframe authorization:** `src/utils/iframeBridge.ts` checks source-window
   identity and RPC namespaces but does not enforce custom-tool
   `appPermissions.agent`. Metadata preservation is not an authorization gate.
2. **Context exclusions:** `server/context/contextLoader.ts` does not apply
   `claudeMdExcludes` to lazy conditional/nested rules. External project/nested
   symlinked rules are skipped even under auto-approval.
3. **Compaction retention:** unconditional rules remain cached; re-attached skill
   records are not collected at a second compaction unless invoked again.
4. **Subagent memory:** tool-spawned children can inherit enabled parent auto-memory;
   agent-owned memory does not check the auto-memory toggle.
5. **Search schema drift:** advertised ripgrep limits/default case sensitivity differ
   from helper/registry behavior. The ripgrep guide distinguishes both contracts.
6. **File safety:** create/delete/directory checks are lexical in the documented
   paths; directory traversal follows symlinks. Create-file overwrite prevention
   is a precheck, not race-proof exclusive creation. Edit/read canonical protections
   must not be assumed to apply to every filesystem helper.
7. **Link fallback:** Markdown external links fall back to `window.open` when the
   preload capability is absent; bridge failures themselves do not fall back.

Paths in this section are relative to `client/ygg-chat-r/`.

## Validation

- Parsed every documentation frontmatter block and checked that its nonempty,
  root-relative routing patterns match current files.
- Checked relative Markdown links and explicitly rooted operational source paths.
- Reviewed the documentation diff and ran `git diff --check -- docs`.
- Did not run application tests/builds or manual OAuth, iframe, provider, animation,
  or packaged-app checks: this change is documentation-only.

Consult the subsystem guides for current details rather than treating this audit
snapshot as an additional implementation contract.
