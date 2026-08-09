# Agent Context: Skills

Last reviewed: 2026-08-09

## Purpose

Documents installation, discovery, normalization, and model activation for Agent Skills in the local Electron app.

## Key Files

- `client/ygg-chat-r/electron/skills/skillManifest.ts`: shared `SKILL.md` parsing, runtime-name normalization, and serialization.
- `client/ygg-chat-r/electron/skills/skillInstaller.ts`: GitHub clone, ClawdHub/zip, and local-folder installation.
- `client/ygg-chat-r/electron/skills/skillLoader.ts`: user-data registry, legacy compatibility, enable/disable state, resources, and uninstall.
- `client/ygg-chat-r/electron/skills/skillRoutes.ts`: Settings API under `/api/skills/*`.
- `client/ygg-chat-r/electron/skills/skillManager.ts`: model-facing `skill_manager` list/activate/load-resource tool.
- `client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`: install and installed-skill UI.
- `client/ygg-chat-r/electron/tools/__tests__/skillInstaller.test.ts` and `skillLoader.test.ts`: installation and compatibility regressions.

## Runtime Data Flow

1. GitHub installs parse a repository, HTTPS `.git`, shorthand, or `/tree/<ref>/<path>` source.
2. The installer runs one shallow, non-interactive HTTPS `git clone`; it does not use the GitHub Contents API to copy skills.
3. The installer discovers `SKILL.md` files from the cloned filesystem, copies selected skill folders into managed staging, and removes `.git` content.
4. Shared manifest logic converts the manifest name to a lowercase kebab-case runtime name. The original name is retained as optional `displayName` metadata.
5. The installer atomically moves staged content, reloads the registry, and reports success only if every expected runtime name is present.
6. Settings and `skill_manager` read the same in-process registry. Settings shows `displayName`; API actions and model activation use normalized `name`.

## Important Invariants

- `name` is the stable runtime activation key. It must be lowercase kebab-case.
- `displayName` is optional presentation metadata and must not be used in enable, disable, uninstall, activate, or resource routes.
- Installer and loader must use the same manifest parser and normalization rules.
- Installation success requires registry visibility, not only a successful filesystem copy.
- Normalized-name collisions must never silently overwrite an existing skill or another candidate.
- Legacy on-disk skills with display-style manifest names load under their normalized runtime key without requiring migration or deletion.
- GitHub clone execution uses argument arrays, disables interactive credential prompts, imports the native shell PATH on POSIX, and always removes temporary clones.
- The official-skill catalog remains GitHub API-backed; this is separate from copying/installing a skill.

## Validation

```bash
npm --prefix client/ygg-chat-r run test:tools
npm --prefix client/ygg-chat-r run typecheck:electron
npm --prefix client/ygg-chat-r run build:electron:main
```

For a focused check:

```bash
npm --prefix client/ygg-chat-r exec vitest run --config vitest.tools.config.ts \
  electron/tools/__tests__/skillInstaller.test.ts \
  electron/tools/__tests__/skillLoader.test.ts
```
