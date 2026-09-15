---
paths:
  - "docs/claude_code_context_loading_rules.md"
---

# Claude Code Context Auto-Loading Rules

Last reviewed: 2026-09-15

This document records every rule Claude Code follows when it discovers, parses, and injects
markdown context files into the model prompt. The target is a 1:1 reimplementation in Graviton
(`ygg-chat`). Section 11 maps each rule to the Graviton code that must change.

Sources, in order of authority:

1. Official docs: `https://code.claude.com/docs/en/memory`, `/skills`, `/sub-agents`, `/hooks`,
   `/plugins`, `/plugins-reference`, `/settings`, `/context-window`. Fetched 2026-09-15.
2. Anthropic-authored `plugin-dev` and `claude-code-setup` plugins (installed locally under
   `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/`).
3. Live observation of a Claude Code session (prompt labels, list formats). Items from this source
   are marked **observed**. They are not guaranteed stable.

Where the docs are silent, this document says so. Do not invent behaviour to fill a gap.

---

## 1. Shared frontmatter contract

Every auto-loaded markdown file (CLAUDE.md, rule, skill, agent, output style, command) uses the
same envelope.

| Rule | Detail |
| --- | --- |
| Delimiters | YAML between `---` on **line 1** and the next `---` line. |
| Opening line | If the first `---` is not on line 1, the file has **no** frontmatter. The whole file is body. |
| Parser | YAML. A parse error skips the file (agents) or drops the frontmatter (rules, CLAUDE.md). The error goes to the debug log. |
| Body | Everything after the closing `---`. Rendered as-is, except the transforms in each section below. |
| Booleans | Accept `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` in any letter case. |
| Lists | Most list fields accept a YAML list **or** a comma- or space-separated string. Per-field detail below. |
| Unknown keys | Ignored. Not an error. |
| HTML comments | Block-level `<!-- ... -->` in CLAUDE.md files are stripped before injection. Comments inside fenced code blocks stay. When the model reads the file with the Read tool, comments stay visible. |
| Size | Claude Code loads a CLAUDE.md file of up to 4 MiB in full. It skips a larger file. |

Frontmatter is optional for CLAUDE.md files and commands. It is required for agents (`name`,
`description`) and effectively required for skills (`description` recommended; `name` defaults to
the directory name).

---

## 2. Instruction files: `AGENTS.md`, `CLAUDE.md`, and their `.local.md` variants

### 2.1 Locations and scopes

Load order is broadest scope first. A later file appears later in context.

| Order | Scope | Path | Shared with | Can be excluded |
| --- | --- | --- | --- | --- |
| 1 | Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; Linux/WSL `/etc/claude-code/CLAUDE.md`; Windows `C:\Program Files\ClaudeCode\CLAUDE.md`; or inline `claudeMd` string in managed settings | Whole org | **No** |
| 2 | User | `~/.claude/CLAUDE.md` | Just you, all projects | Yes |
| 3 | Project (ancestor chain) | `<dir>/CLAUDE.md` **or** `<dir>/.claude/CLAUDE.md` for every `<dir>` from filesystem root down to cwd | Team via VCS | Yes |
| 4 | Local (ancestor chain) | `<dir>/CLAUDE.local.md` for the same `<dir>` set | Just you, this project | Yes |
| 5 | Nested (lazy) | `<subdir>/CLAUDE.md`, `<subdir>/.claude/CLAUDE.md`, `<subdir>/CLAUDE.local.md` for any `<subdir>` **below** cwd | Same as 3/4 | Yes |

`~/.claude` can be relocated with the `CLAUDE_CONFIG_DIR` environment variable.

### 2.2 Discovery algorithm

1. **At launch**, walk from the filesystem root down to the current working directory. In each
   directory, collect `CLAUDE.md` (or `.claude/CLAUDE.md`), then `CLAUDE.local.md`.
2. **Concatenate.** Files do not override each other. Root-most content comes first. Content in the
   cwd comes last. Within one directory, `CLAUDE.local.md` is appended after `CLAUDE.md`.
3. **Below cwd, do not load at launch.** When the model reads a file inside a subdirectory, inject
   that subdirectory's `CLAUDE.md` / `CLAUDE.local.md` at that moment. The docs call this
   "nested traversal". The `InstructionsLoaded` hook reports `load_reason: nested_traversal`.
   The docs do not state whether every ancestor between cwd and the read file is checked, or only
   the file's own directory. Treat the whole chain as the safe implementation.
4. Each file loads **once** per session. A second read of the same subdirectory does not
   re-inject.
5. Files from `--add-dir` directories are **not** loaded unless
   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set. With it set, Claude Code loads
   `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, and `CLAUDE.local.md` from each
   added directory.
6. Auto-memory `MEMORY.md` is loaded separately (section 4).

`CLAUDE.md` and `.claude/CLAUDE.md` in the same directory: the docs say "either". They do not say
what happens when both exist. Do not rely on both.

### 2.3 Imports: `@path`

| Rule | Detail |
| --- | --- |
| Syntax | `@path/to/file`, `@./relative`, `@../up`, `@/absolute`, `@~/home-relative`. |
| Resolution | Relative to the **file that contains the import**, not the cwd. |
| Recursion | Imported files may import. Maximum depth is **four hops**. |
| Code exclusion | Imports inside inline code spans (`` `@x` ``) and fenced code blocks are **not** expanded. |
| Timing | Expanded at launch, together with the CLAUDE.md that references them. They cost context like any launch-time file. |
| External imports | An import that resolves **outside the working directory** from a project-level file triggers a one-time approval dialog listing the files. Decline disables them and the dialog does not return. |
| User-scope imports | Imports in `~/.claude/CLAUDE.md` and `~/.claude/rules/` load without a dialog (except Cowork desktop sessions, which skip imports outside the session cwd and skip a symlinked `~/.claude/CLAUDE.md`). |
| `AGENTS.md` | Claude Code does **not** read it directly. Documented pattern: `CLAUDE.md` containing `@AGENTS.md`, or a symlink `CLAUDE.md -> AGENTS.md`. Graviton reads it directly; see section 2.7. |
| Hook reason | `InstructionsLoaded` reports `load_reason: include` for imported files. |

### 2.4 Rendering into the prompt

- CLAUDE.md content is delivered **as a user message after the system prompt**, not inside the
  system prompt (docs, "Troubleshoot" section).
- **Observed** wrapper: a `<system-reminder>` block that begins with a sentence like
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions.", then
  one labelled section per file:
  - `Contents of <abs path> (user's private global instructions for all projects):` for `~/.claude/CLAUDE.md`
  - `Contents of <abs path> (project instructions, checked into the codebase):` for project files and rules
  - `Contents of <abs path> (user's private project instructions, not checked in):` for `CLAUDE.local.md`
  - `Contents of <abs path> (user's auto-memory, persists across conversations):` for `MEMORY.md`
- Lazy files (nested CLAUDE.md, path-scoped rules) are injected as a `<system-reminder>` next to
  the tool result that triggered them (**observed**).
- `/context` lists what actually loaded under **Memory files**. `/memory` lists locations
  whether or not the file exists.

### 2.5 Settings and environment that change discovery

| Key | Where | Effect |
| --- | --- | --- |
| `claudeMdExcludes: string[]` | Any settings layer; arrays merge | Glob patterns matched against **absolute paths**. Skips matching CLAUDE.md and `.claude/rules/**` files. For a symlinked rule, a pattern matching either the link path or the target excludes it. Managed policy files cannot be excluded. |
| `claudeMd: string` | Managed settings only | Inline managed instructions. Same precedence as a managed CLAUDE.md file. Ignored in user/project/local settings. |
| `--setting-sources` (CLI) | Launch | Exclude `project` and project rules are skipped. Exclude `local` and `CLAUDE.local.md` from added directories is skipped. |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | Env | Load memory files from `--add-dir` directories. |
| `CLAUDE_CONFIG_DIR` | Env | Relocate `~/.claude`. |
| `includeGitInstructions: false` | Settings | Drops the git status snapshot from startup context (also for subagents). |

### 2.6 Compaction

After `/compact` or auto-compaction:

- Project-root CLAUDE.md is **re-read from disk and re-injected**.
- Nested CLAUDE.md and path-scoped rules are **not** re-injected until a matching file is read again.
  `InstructionsLoaded` reports `load_reason: compact` for the re-injected ones.
- Skill descriptions and `MEMORY.md` reload.
- Full content of invoked skills is re-attached within a budget (section 5.4).

### 2.7 `AGENTS.md`: the open standard and how Graviton merges it

Source: `https://agents.md/` (fetched 2026-09-15). Supported by 60+ tools, including OpenAI Codex,
Google Jules, Cursor, GitHub Copilot, Zed, Devin, Aider, and Junie.

The standard defines only four things:

| Rule | Text of the standard |
| --- | --- |
| Filename | `AGENTS.md`, plain Markdown. |
| Location | Repository root. Nested `AGENTS.md` files are allowed in monorepo subdirectories and packages. |
| Precedence | "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything." |
| Format | No required sections. No frontmatter. "The agent simply parses the text you provide." |

The standard is silent on: user-level files, `.local` variants, imports, code-span exclusion,
size limits, lazy loading, exclusion settings, and rendering. Claude Code defines all of those for
`CLAUDE.md`. Graviton applies the Claude Code rules of sections 2.1 to 2.6 to **both** filenames.

**Merge rules Graviton follows.** Decision recorded 2026-09-15.

1. **Filename set.** Wherever section 2 says `CLAUDE.md`, discover this ordered set in the same
   directory: `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`. Wherever it says `CLAUDE.local.md`,
   discover `AGENTS.local.md` then `CLAUDE.local.md`. `AGENTS.local.md` is a Graviton extension, not
   part of the standard.
2. **Per-directory order.** Within one directory, append in this order: `AGENTS.md`, `CLAUDE.md`
   (or `.claude/CLAUDE.md`), `AGENTS.local.md`, `CLAUDE.local.md`. Shared files first, personal
   files last, standard file before vendor file.
3. **Precedence across directories.** Use the Claude Code rule: concatenate root-first, closest
   directory last. This satisfies the standard's "closest wins" because the closest file is the last
   instruction the model reads. Do **not** drop ancestor files. The standard does not ask for that.
4. **Dedupe.** Before injecting a file, resolve its real path. Skip it when a file with the same real
   path was already injected in this session. This covers `ln -s AGENTS.md CLAUDE.md` and
   `ln -s AGENTS.md AGENT.md`. Also skip a `CLAUDE.md` whose body, after trimming, is only
   `@AGENTS.md` when `AGENTS.md` in the same directory was already injected. Any other `CLAUDE.md`
   content still loads, so Claude-specific additions below the import are kept.
5. **Imports.** `@path` works in `AGENTS.md` exactly as in `CLAUDE.md` (section 2.3). The standard
   does not define imports, so an `AGENTS.md` written for other tools will not contain them and loses
   nothing.
6. **Nested lazy load.** `<subdir>/AGENTS.md` loads on the same trigger as `<subdir>/CLAUDE.md`
   (section 2.2 step 3). This is how the standard's "closest to the edited file" rule is met for
   files below cwd.
7. **User scope.** Read `~/<readDir>/AGENTS.md` then `~/<readDir>/CLAUDE.md` for each `readDirs`
   entry (section 11.4), in the slot where Claude Code reads `~/.claude/CLAUDE.md`. The standard has
   no user-scope concept, so this is an extension. Decision 9 in section 11.3.
8. **Labels.** Render with the same `Contents of <abs path> (...)` labels as section 2.4. The path
   shows which filename was loaded.
9. **Exclusions.** `claudeMdExcludes` patterns apply to both filenames because they match absolute
   paths.
10. **Legacy `AGENT.md` (singular).** Not discovered. The standard's own migration is
    `mv AGENT.md AGENTS.md && ln -s AGENTS.md AGENT.md`, which rule 4 already handles.
11. **Chat instructions override.** The standard's second clause is already true. Instruction files
    are context. A user message later in the conversation carries more weight.

Everything else in this document that names `CLAUDE.md` (rules directory, skills, agents, hooks,
subagent startup context, compaction) applies unchanged to `AGENTS.md`.

---

## 3. Rules: `.claude/rules/*.md`

### 3.1 Locations

| Scope | Path | Order |
| --- | --- | --- |
| User | `~/.claude/rules/**/*.md` | Loaded first (lower priority) |
| Project | `<project>/.claude/rules/**/*.md` | Loaded second (higher priority) |
| Managed | `.claude/rules/` inside the managed settings directory | With managed policy |
| Added dirs | `<add-dir>/.claude/rules/*.md` | Only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` |

- Discovery is **recursive**. Subdirectories such as `rules/frontend/` are allowed and have no
  semantic meaning.
- **Symlinks** are followed. Circular symlinks are detected. A symlink whose target is outside the
  working directory is treated like an external import: nothing loads until external imports are
  approved for the project, and after approval only rules **without** `paths` load.
- Nested `.claude/rules/` directories below cwd exist ("rules in nested `.claude/rules/`
  directories" load on demand). The docs do not describe the trigger in detail. Treat them like
  nested CLAUDE.md: inject when a file in that subtree is read.

### 3.2 Frontmatter

Only one key is documented for rules.

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `paths` | string list, or a single string | No | Glob patterns. Present: the rule is **conditional**. Absent: the rule is **unconditional** and loads at launch "with the same priority as `.claude/CLAUDE.md`". |

Example:

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "lib/**/*.{ts,tsx}"
---

# API rules
- Validate every input.
```

### 3.3 Glob semantics

| Token | Meaning |
| --- | --- |
| `**` | Any depth of directories, including zero. |
| `*` | Any characters inside one path segment. |
| `{a,b}` | Brace expansion. Each group multiplies the pattern count. |
| `[abc]` | Bracket expression. A `[` that cannot be read as a bracket expression makes that pattern invalid. An invalid pattern matches nothing. The rule's other patterns keep working. Escape a literal `[` as `\[`. |
| Anchoring | Patterns are relative to the **project root**. `*.md` matches only root-level markdown files. `**/*.ts` matches at any depth. |

Budget: one rule's whole `paths` list shares a budget of **1,000 expanded patterns and 4 MiB**.
Patterns without braces do not count. A pattern that would exceed the budget is used unexpanded and
its literal braces match no file.

### 3.4 Trigger

- A conditional rule injects **when the model reads a file whose path matches**, "not on every
  tool use". Since v2.1.198 a read through a symlinked project path also matches.
- The docs name the Read tool. They do not list Edit or Write as triggers. The safe reading is:
  trigger on the Read tool; optionally also on edit tools. Graviton should make this a flag.
- Once injected, the rule stays for the session. It is not re-injected on later matches.
- `InstructionsLoaded` reports `load_reason: path_glob_match`.
- `paths` in a **skill** (section 5.7) uses the same glob format and the same trigger.

### 3.5 Rendering

Rules render like CLAUDE.md (same `Contents of <path> (...)` label, **observed**). `/context` shows
which rules loaded. The transcript shows "Loaded .claude/rules/<file>" without the content.

---

## 4. Auto memory

Not a user-authored file, but it is an auto-loaded markdown file. Graviton already has a memory
store under `.ygg`. The target is: keep the `.ygg` location, adopt the Claude Code load rules.

### 4.1 Graviton location (current code)

| Item | Path | Source |
| --- | --- | --- |
| Data dir | Electron `app.getPath('userData')`, exported as `YGG_APP_USER_DATA`; `YGG_DATA_DIR` outside Electron | `electron/main.ts:1034`, `server/serverConfig.ts:143` |
| Memory dir | `<dataDir>/.ygg/memory/` | `server/routes/memoryRoutes.ts:22` |
| Global memory | `<dataDir>/.ygg/memory/memory.md` | `memoryRoutes.ts:23` |
| Recent memory | `<dataDir>/.ygg/memory/recent_memory.md` | `memoryRoutes.ts:24` |
| Project memory | `<dataDir>/.ygg/memory/projects/<sanitized project name>/project_memory.md` | `memoryRoutes.ts:39` |
| Read caps | `GET /api/memory/context`: `maxChars` default 10,000, `recentMaxChars` default = `maxChars`, `projectMaxChars` default 12,000, all clamped to 100,000. Truncation keeps the **tail** of the file. | `memoryRoutes.ts:180-199` |
| Injection | Renderer only, `src/features/chats/chatActions.ts:625`. Not ported to the headless loop (`chatHookService.ts:15-18`). | |

Other `.ygg` users for reference: hooks config `<dataDir>/.ygg/settings.json` (`server/hooks/hookStorage.ts:6,157`),
custom themes `<dataDir>/.ygg/custom-themes` (`electron/main.ts:1041`). Skills live at
`<dataDir>/skills`, **not** under `.ygg` (`server/skills/skillLoader.ts:9,93`).

### 4.2 Rules to adopt (Claude Code) mapped onto `.ygg`

| Rule | Claude Code | Graviton target |
| --- | --- | --- |
| Directory | `~/.claude/projects/<project-slug>/memory/` | `<dataDir>/.ygg/memory/projects/<project-slug>/` |
| Slug | Derived from the git repo root, so all worktrees and subdirectories of one repo share one directory. Outside git, the project root path. | Same. Derive from the conversation `rootPath` (`chatOrchestrator.ts:626-637`), not from the project **name**. The current name-based slug at `memoryRoutes.ts:25-36` splits memory across renamed projects and merges unrelated projects with one name. |
| Slug override | `CLAUDE_CODE_PROJECT_DIR_NAME` (needs `CLAUDE_CONFIG_DIR`) | `YGG_MEMORY_PROJECT_DIR_NAME` (new) |
| Directory override | `autoMemoryDirectory` setting, absolute or `~/` path, any settings scope | Same key, same value rules, in Graviton settings |
| Index file | `MEMORY.md`. Loaded at every session start: **first 200 lines or first 25 KB, whichever comes first**. Content beyond is dropped. After a write, warn near the limit and return an error over it. | Same file name and limits. Replace the tail-truncating `maxChars` read with a head read of 200 lines / 25 KB. |
| Topic files | One file per memory beside the index. **Not** loaded at start. Read on demand. | Same. `memory.md` and `recent_memory.md` become topic files or are folded into `MEMORY.md`. Decide during implementation. |
| Frontmatter | `type: user \| feedback \| project \| reference` written by the model. `modified: <ISO 8601>` added on every write to a file that already has frontmatter (v2.1.214+). Never adds frontmatter to a file without one. | Same. Add the `modified` stamp in the memory write route. |
| Toggles | `autoMemoryEnabled: false` (any scope) or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `autoMemoryEnabled` setting (exists in the renderer as `loadLongTermMemoryContextEnabled()`) and `YGG_DISABLE_AUTO_MEMORY=1` |
| Rendering | `Contents of <abs path> (user's auto-memory, persists across conversations):` inside the memory system-reminder, after CLAUDE.md files and rules (**observed**) | Same label, same slot, in the headless loop |
| Compaction | `MEMORY.md` reloads after compaction | Same |
| Subagents | Not loaded into subagents. A fork inherits it. A subagent with `memory:` has its own directory (section 6.5). | Same. Agent memory: `<dataDir>/.ygg/agent-memory/<name>/` for `user`; `<root>/<writeDir>/agent-memory/<name>/` for `project`; `<root>/<writeDir>/agent-memory-local/<name>/` for `local`. `<writeDir>` is the user's chosen in-repo config directory (section 11.4). |

Retention: Claude Code excludes the memory directory from its transcript cleanup sweep. Graviton
has no such sweep today. If one is added, exclude `.ygg/memory/`.

---

## 5. Skills: `SKILL.md`

### 5.1 Locations and precedence

| Priority | Scope | Path | Invocation name |
| --- | --- | --- | --- |
| 1 (highest) | Enterprise | `.claude/skills/<name>/SKILL.md` in the managed settings directory | `/<name>` |
| 2 | Personal | `~/.claude/skills/<name>/SKILL.md` | `/<name>` |
| 3 | Project | `<project>/.claude/skills/<name>/SKILL.md` | `/<name>` |
| 4 | Nested | `<subdir>/.claude/skills/<name>/SKILL.md` for `<subdir>` below the project root | `/<subdir-path>:<name>`, for example `/apps/web:deploy` |
| 4 | Added dir | `.claude/skills/<name>/SKILL.md` in an `--add-dir` directory | `/<name>` |
| separate | Plugin | `<plugin>/skills/<name>/SKILL.md`, or `<plugin>/SKILL.md` at plugin root | `/<plugin>:<name>` always; bare `/<name>` also works when unambiguous |
| separate | Synced from claude.ai | `~/.claude/skills/synced/` | `/anthropic-skills:<name>`; bare `/<name>` when unambiguous |
| same as project | Legacy command | `.claude/commands/<name>.md` or `.claude/commands/<dir>/<name>.md` | `/<name>` or `/<dir>:<name>` |
| lowest | Bundled | Ships with Claude Code | `/<name>` unless `disableBundledSkills: true` |

Collision rules:

- Same bare name in two local scopes: `/<name>` runs the highest-priority one. Every version stays
  listed. Nested versions keep their path-qualified name.
- A local skill at any scope replaces a **bundled** skill of the same name, but not the bundled
  skill's aliases.
- A skill and a legacy command with the same name: the skill wins.
- Plugin skills never collide with local skills because they are namespaced.
- Nested skills load "when Claude first works on files there" (docs). Sessions started in or below
  `<subdir>` also see them.

### 5.2 Frontmatter (complete)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | Directory name | Display and invocation name. For plugin skills, the last segment after `plugin:`. Normalised to lowercase-kebab in practice. A `name` that already starts with the plugin prefix is not prefixed again (v2.1.246+). |
| `description` | string | First non-empty body line | What the skill does and when to use it. Drives model invocation. |
| `when_to_use` | string | none | Appended to `description` for the model. Together they are **truncated at 1,536 characters** in the listing. |
| `argument-hint` | string | none | Autocomplete hint, for example `[issue-number]`. |
| `arguments` | list or space-separated string | none | Named positional arguments. `arguments: [issue, branch]` enables `$issue`, `$branch`. |
| `disable-model-invocation` | boolean | `false` | `true`: only the user can run it; the description is **not** in context; it cannot be preloaded into subagents or run by scheduled tasks. |
| `user-invocable` | boolean | `true` | `false`: hidden from the `/` menu; only the model can run it; the description **is** in context. |
| `allowed-tools` | list or space/comma string | none | Tools pre-approved for the **turn** that invokes the skill. Cleared on the next user message. Permission-rule syntax, for example `Bash(git *)`. |
| `disallowed-tools` | list or space/comma string | none | Tools removed while the skill is active. Cleared on the next user message. |
| `model` | string | inherit | Model for the turn. Same values as `/model`, or `inherit`. With `context: fork` it sets the subagent model. |
| `effort` | `low\|medium\|high\|xhigh\|max` | inherit | Effort for the turn. |
| `context` | `fork` | none | Run the skill body as the prompt of a fresh subagent instead of inline. |
| `agent` | string | `general-purpose` | Agent type used with `context: fork`: `Explore`, `Plan`, `general-purpose`, or a custom agent name. |
| `background` | boolean | `true` | With `context: fork`: `false` waits for the result in the same turn (v2.1.218+). |
| `hooks` | object | none | Hooks registered on invocation, kept for the rest of the session. Same schema as settings hooks plus `once`. |
| `paths` | list or comma string | none | Glob patterns. The model auto-loads the skill only when working with matching files. Manual `/name` still works. Same glob format as rules. |
| `shell` | `bash\|powershell` | `bash` | Shell for `` !`cmd` `` injection. |
| `metadata` | map | none | Free-form. Not acted on. Must be a map. |
| `license` | string | none | Agent Skills spec field. Accepted, not acted on. |
| `compatibility` | string ≤ 500 chars | none | Agent Skills spec field. Accepted, not acted on. |
| `version` | string | none | Common in the wild (`version: 0.1.0`). Not in the Claude Code table. Accepted as an unknown key. |

Legacy `.claude/commands/*.md` files accept the same keys **except** `name` and `paths`.

Invocation matrix:

| Frontmatter | User can run | Model can run | Description in context | Body loads |
| --- | --- | --- | --- | --- |
| default | Yes | Yes | Yes | On invocation |
| `disable-model-invocation: true` | Yes | No | **No** | When the user invokes |
| `user-invocable: false` | No | Yes | Yes | When the model invokes |
| both | No | No | No | Never |

### 5.3 Startup index

- At launch Claude Code loads **only** `name` + `description` (+ `when_to_use`) for every
  discoverable skill that does not set `disable-model-invocation: true`. Bodies are never read at
  launch.
- **Observed** rendering, inside the system prompt: a header line
  "The following skills are available for use with the Skill tool:" followed by one bullet per
  skill, `- <name>: <description>`. Plugin skills use `plugin:name`. Nested skills use
  `path:name`. Skills from claude.ai are labelled as such.
- Per-skill cap: 1,536 characters of description text. The docs do not publish a total budget or an
  environment variable to raise it. Do not assume one.
- `skillOverrides: {"<name>": "off" | "name-only"}` in settings can drop a skill or shrink its
  entry to the name only.

### 5.4 Invocation and body lifecycle

- Two entry points: the user types `/name args`, or the model calls the **Skill tool** with the
  name and optional args. Both render the body the same way.
- Rendering pipeline, in order: (1) argument substitution (5.5), (2) `${CLAUDE_*}` substitution,
  (3) `` !`command` `` execution (5.6). Substitution runs **once** over the original file; command
  output is inserted as text and not re-scanned.
- The rendered body enters the conversation **as a single message** and stays across turns.
  Claude Code does not re-read the file on later turns.
- Re-invoking with **identical** rendered content adds a short note instead of a duplicate.
  Different rendered content (new arguments, new shell output) appends the full body again.
- `@path` references in a skill body behave like CLAUDE.md imports (**observed**; the skills doc
  only shows the pattern).
- Compaction: the most recent invocation of each invoked skill is re-attached after the summary,
  **first 5,000 tokens per skill**, **25,000 tokens combined**, oldest dropped first.
- Stacking: `/a /b args` expands the first skill plus up to 5 more. The run stops at the first
  skill that is not inline user-invocable (for example a `context: fork` skill).
- Permissions: `Skill` (deny all), `Skill(name)` exact, `Skill(name *)` prefix with arguments.
  Nested skills are matched by unqualified name in allow rules and by both names in deny rules
  (v2.1.260+).

### 5.5 Substitutions

| Token | Expands to |
| --- | --- |
| `$ARGUMENTS` | All arguments as one string. |
| `$ARGUMENTS[N]` | Argument N, **0-based**, shell-style quoting (`"hello world"` is one argument). |
| `$N` (`$0`, `$1`, …) | Shorthand for `$ARGUMENTS[N]`. |
| `$<name>` | Named argument from `arguments:`. Missing named argument → empty string. |
| `${CLAUDE_SESSION_ID}` | Session id. |
| `${CLAUDE_SKILL_DIR}` | Directory containing this `SKILL.md`. |
| `${CLAUDE_PROJECT_DIR}` | Project root (v2.1.196+). |
| `${CLAUDE_EFFORT}` | Current effort level. |
| `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` | Plugin skills only. |

Rules: a missing indexed argument leaves the placeholder unchanged. Argument values containing
`$1` or `$ARGUMENTS` are inserted literally. `\$1` escapes; `\\$1` keeps both backslashes and still
expands. Escaping does not apply to `${CLAUDE_*}`.

### 5.6 Dynamic shell injection

| Rule | Detail |
| --- | --- |
| Inline form | `` !`git diff HEAD` `` where `!` is at line start or after whitespace. `KEY=!`cmd`` is literal. |
| Block form | A fenced block whose info string is `!`: ```` ```! ```` … ```` ``` ````. One command per line. |
| Shell | `shell: powershell` with PowerShell enabled → PowerShell. `shell: bash` without bash → skill fails. Otherwise Bash if available, else PowerShell. |
| Cwd | The session shell's current directory. |
| Timeout | 2 minutes per command. |
| stderr | Merged into stdout (bash). |
| Failure | A non-zero exit aborts the whole invocation; the model never sees the body. Search/compare commands (`grep`, `git diff`, `git log`, `find`, `diff`, …) treat exit 1 as success. Append `\|\| true` elsewhere. |
| Permissions | A failed permission check also aborts. Pre-approve with `allowed-tools`. |
| Disable | `disableSkillShellExecution: true` replaces each command with `[shell command execution disabled by policy]`. Applies to user/project/plugin/added-dir skills, not bundled or managed ones. |

### 5.7 `paths` on skills

Same glob format and root anchoring as rule `paths` (section 3.3). When set, the model auto-loads the
skill only while working with matching files. Manual invocation is unaffected. Format may be a YAML
list or a **comma-separated string** (`paths: "src/**/*.tsx,src/hooks/*.ts"`).

### 5.8 `context: fork`

- The skill body becomes the task prompt of a fresh subagent. No conversation history.
- `agent:` picks the subagent definition. `Explore` and `Plan` are read-only and **skip CLAUDE.md
  and git status**. Custom agents from `.claude/agents/` are allowed.
- `background: true` (default) runs it in the background. Claude Code waits anyway in `-p` mode,
  with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, when a prior invocation is still running, and
  when a scheduled task fires the skill.
- The inverse: an agent's `skills:` list preloads full skill bodies into that agent (section 6.2).

### 5.9 Supporting files and size

- Keep `SKILL.md` under **500 lines**. Put detail in sibling files and link to them from the body
  so the model reads them on demand. Convention: `references/`, `scripts/`, `assets/`,
  `examples/`. Scripts are executed, not loaded.
- Everything in the skill directory except `SKILL.md` costs nothing until read.

---

## 6. Subagents: `.claude/agents/*.md`

### 6.1 Locations and precedence

| Priority | Location | Notes |
| --- | --- | --- |
| 1 | Managed settings `.claude/agents/` | Same format. |
| 2 | `--agents '<json>'` CLI flag | Session only. JSON keys are names; values take `prompt` plus every frontmatter field. |
| 3 | `<project>/.claude/agents/**/*.md` | Discovered by **walking up from cwd**. Recursive. Closest definition to cwd wins on a name clash (v2.1.178+). |
| 4 | `~/.claude/agents/**/*.md` | Recursive. Subfolder path does not affect identity. |
| 5 | `<plugin>/agents/**/*.md` | Recursive. Subfolder becomes part of the id: `agents/review/security.md` → `my-plugin:review:security`. Plugin agents ignore `hooks`, `mcpServers`, `permissionMode`. |
| — | `--add-dir` directories | Their `.claude/agents/` load too, not watched for changes. |

Identity comes from the `name` field, not the filename. Two files with the same `name` in one
directory: only one loads (filesystem order). `/doctor` reports duplicates.

### 6.2 Frontmatter (complete)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | **required** | Lowercase letters and hyphens. Must not start with `-`. Must not contain `:`. Passed to hooks as `agent_type`. |
| `description` | string | **required** | When to delegate. Combined descriptions of all custom agents over 15,000 tokens trigger a warning. |
| `tools` | list or comma string | all subagent tools | Allow-list. MCP patterns `mcp__<server>`, `mcp__<server>__*`. `Agent(a, b)` restricts which agents it may spawn. |
| `disallowedTools` | list or comma string | none | Deny-list applied **before** `tools`. `Bash(git push *)` removes the whole Bash tool. `mcp__*` removes all MCP tools. |
| `model` | string | resolved by subagent model order | `sonnet`, `opus`, `haiku`, `fable`, a full model id, or `inherit`. |
| `permissionMode` | string | inherit | `default` (`manual`), `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. The main conversation's mode overrides it when the main mode is `bypassPermissions`, `acceptEdits`, or `auto`. |
| `maxTurns` | positive int | unlimited | Stop after N agentic turns; output marked partial; resumable (v2.1.246+). |
| `skills` | list of names | none | **Full bodies** injected at startup. Not a whitelist. Cannot preload `disable-model-invocation: true` skills. Missing skills are skipped with a debug warning. |
| `mcpServers` | list of names or inline defs | none | Inline defs connect at start and disconnect at end. |
| `hooks` | object | none | Scoped to the subagent's lifetime. `Stop` becomes `SubagentStop`. |
| `memory` | `user\|project\|local` | none | Own auto-memory directory (6.5). No effect if auto memory is off. |
| `background` | boolean | `false` | Force background even when the model asks for foreground. |
| `omitClaudeMd` | boolean | `false` | Start without user/project/local CLAUDE.md. Managed files still load. Ignored when the agent is the main session (v2.1.271+). |
| `effort` | `low\|medium\|high\|xhigh\|max` | inherit | Effort override. |
| `isolation` | `worktree` | none | Run in a temporary git worktree branched from the default branch. Auto-cleaned if unchanged. |
| `color` | string | none | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. |
| `initialPrompt` | string | none | Auto-submitted first user turn when the agent is the main session (`--agent`). |
| `experimental` | map | none | `cacheTtl: "5m" \| "1h"` (v2.1.248+). |

The **body** is the subagent's system prompt.

### 6.3 Validation

Claude Code **skips** a file and logs to the debug log when: there is no `name` (treated as
documentation); `name` starts with `-` or contains `:` (v2.1.218+); there is a `name` but no
`description`; YAML fails to parse. An opening `---` not on line 1 means "no frontmatter", so the
file has no `name` and is skipped. `claude plugin validate <dir>` checks a directory (v2.1.233+).

### 6.4 Startup context of a non-fork subagent

In order:

1. Its own system prompt (body or `prompt`) plus environment details. **Not** the main Claude Code
   system prompt.
2. The delegation message written by the parent model.
3. Every CLAUDE.md level (user, project ancestors, local, rules, managed), unless
   `omitClaudeMd: true` or the agent is the built-in `Explore` or `Plan`.
4. Git status snapshot from the parent session start (unless `includeGitInstructions: false`, or
   `Explore`/`Plan`).
5. Full bodies of `skills:` entries.
6. Sibling roster system-reminder (only when the agent has `SendMessage` and another agent is named;
   v2.1.206+).

It does **not** receive: parent conversation history, skills already invoked by the parent, files
the parent read, the parent's output style, the parent's auto memory, the `Agent` tool (recursion
guard).

**Observed** rendering of the agent index in the **parent** system prompt: "Available agent types
for the Agent tool:" followed by `- <name>: <description> (Tools: <list>)` per agent.

A **fork** (`context: fork` skill, `/subtask`, `/fork`) is the exception: it inherits the parent's
full history, system prompt, model, tool pool, and auto memory.

### 6.5 Subagent memory

| `memory` | Directory |
| --- | --- |
| `user` | `~/.claude/agent-memory/<name>/` |
| `project` | `<project>/.claude/agent-memory/<name>/` (recommended; commit it) |
| `local` | `<project>/.claude/agent-memory-local/<name>/` (gitignore it) |

`MEMORY.md` there loads with the same 200-line / 25 KB rule. Read, Write, Edit are auto-enabled for
that directory. Management instructions are appended to the subagent system prompt.

---

## 7. Output styles: `.claude/output-styles/*.md`

Lightly documented. Locations: project `.claude/output-styles/` and user
`~/.claude/output-styles/`. Frontmatter: `name`, `description`, and
`keep-coding-instructions: boolean` (default `false`; `true` keeps the coding parts of the default
system prompt). The body replaces the default style section of the system prompt. Subagents do not
inherit the parent's output style unless forked.

---

## 8. Plugins

### 8.1 Layout

```
<plugin>/
├── .claude-plugin/plugin.json   # manifest; required for a distributable plugin
├── skills/<name>/SKILL.md       # or a single SKILL.md at plugin root
├── agents/**/*.md
├── commands/*.md                # legacy flat commands
├── hooks/hooks.json             # {"description"?: string, "hooks": {<Event>: [...]}}
├── output-styles/*.md
├── .mcp.json
├── .lsp.json
├── settings.json                # defaults on enable; today only "agent"
├── monitors/monitors.json
├── bin/                         # added to PATH (v2.1.265+; not for marketplaces)
└── scripts/, references/, ...
```

Component directories must sit at the plugin root, **not** inside `.claude-plugin/`.

### 8.2 `plugin.json`

Required: `name` (kebab-case, unique; becomes the namespace). Optional: `displayName`, `version`,
`description`, `author {name,email,url}`, `homepage`, `repository`, `license`, `keywords`,
`skills`, `agents`, `commands`, `hooks`, `mcpServers`, `lspServers`, `monitors`, `settings`,
`dependencies`, `userConfig`, `bin`. Path fields are relative to the plugin root and must start
with `./`. Arrays are allowed. Custom paths **supplement** the default directories; they do not
replace them.

Version resolution when `version` is absent: git tag, then file mtime, then file hash, then
custom source logic.

### 8.3 Namespacing and variables

- Skills: `/<plugin>:<skill>`. Agents: `<plugin>:<subdir>:<agent>`. MCP tools:
  `mcp__plugin_<plugin>_<server>__<tool>`.
- `${CLAUDE_PLUGIN_ROOT}` = install directory. `${CLAUDE_PLUGIN_DATA}` = persistent data directory
  that survives updates. Both are substituted in skill bodies, hooks, and `.mcp.json`.
- Marketplace: `.claude-plugin/marketplace.json` with `name`, `owner`, `plugins[]` (each with
  `name`, `description`, `source`, `category`, `author`, `homepage`), and optional `renames` map.
- Installed-plugin scopes and precedence: managed > project `.claude/plugins/` > user
  `~/.claude/plugins/` > skills-dir plugins (`~/.claude/skills/<name>/.claude-plugin/plugin.json`,
  auto-loaded as `<name>@skills-dir`) > marketplace. `--plugin-dir` overrides for one session.
- `/reload-plugins` reloads plugins, skills, agents, and hooks without restart.

---

## 9. Hooks as a context channel

Hooks are the only enforced (not advisory) mechanism, and the second way to inject context.

### 9.1 Config locations

`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed
settings, plugin `hooks/hooks.json`, skill frontmatter (`hooks:`), agent frontmatter (`hooks:`).
`disableAllHooks: true` turns all off. Project frontmatter hooks run only after the workspace
trust dialog is accepted.

### 9.2 Schema

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          {
            "type": "command | http | mcp_tool | prompt | agent",
            "if": "Bash(git *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh",
            "args": ["exec-form", "optional"],
            "timeout": 600,
            "statusMessage": "Checking…",
            "async": false,
            "once": false
          }
        ]
      }
    ]
  }
}
```

- `matcher`: exact tool name, `a|b` or `a,b` lists, `*`, or a regex when it contains other
  characters. Omit for all occurrences. Events without a tool use their own matcher vocabulary
  (`SessionStart`: `startup|resume|clear|compact|fork`; `InstructionsLoaded`:
  `session_start|nested_traversal|path_glob_match|include|compact`; `PreCompact`: `manual|auto`).
- `once` works only in skill/agent frontmatter. It removes the hook after the first **successful**
  run.
- Timeouts: 600 s for command/http/mcp_tool, 30 s for prompt, 60 s for agent; lowered to 30 s on
  `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`, and 10 s on `MessageDisplay`.

### 9.3 Events

Session: `SessionStart`, `SessionEnd`, `Setup`. Turn: `UserPromptSubmit`, `UserPromptExpansion`,
`Stop`, `StopFailure`. Tool: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
`PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `TaskCreated`,
`TaskCompleted`, `Elicitation`, `ElicitationResult`. Standalone: `PreCompact`, `PostCompact`,
`InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`,
`WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `Notification`,
`MessageDisplay`, `TeammateIdle`.

### 9.4 Injecting context

| Method | Events | Detail |
| --- | --- | --- |
| Plain stdout, exit 0 | `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch` | stdout is added as context the model sees (unless it parses as JSON). |
| JSON `hookSpecificOutput.additionalContext` | Any event that supports JSON output, notably `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit` | Injected as a system-reminder (**observed** label: "UserPromptSubmit hook additional context: …"). |
| `systemMessage` | Any | Shown to the user, not the model. |
| Exit 2 + stderr | Blocking events | Blocks the action; stderr goes to the model as the reason. |
| `SessionStart` with matcher `compact` | Post-compaction | Re-inject context after compaction. |

Hook input arrives as JSON on stdin with `session_id`, `cwd`, `hook_event_name`, plus
event-specific fields (`tool_name`, `tool_input`, `file_path`, `load_reason`, …). Environment:
`CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `CLAUDE_ENV_FILE`, `CLAUDE_PLUGIN_ROOT`.

Multiple hooks for one event run in parallel; permission results merge with the most restrictive
winning; every `additionalContext` is kept.

---

## 10. Startup context composition (summary)

Approximate order in a fresh session, from the `/context` visualisation:

1. Core system prompt (fixed).
2. Tool schemas (built-in; MCP schemas deferred by default).
3. Skill index: `- name: description` lines (section 5.3). **In the system prompt.**
4. Agent index: `- name: description (Tools: …)` lines (section 6.4). **In the system prompt.**
5. Environment block: cwd, platform, git status snapshot, date.
6. Memory files, **as the first user-side system-reminder**, in this order: managed CLAUDE.md →
   `~/.claude/CLAUDE.md` → ancestor CLAUDE.md root-first → CLAUDE.local.md per directory →
   unconditional rules (user then project) → auto-memory `MEMORY.md`. In Graviton each
   `CLAUDE.md` slot is the filename set of section 2.7, `AGENTS.md` first.
7. Then, lazily during the session: nested CLAUDE.md, path-scoped rules, path-scoped skills, skill
   bodies on invocation, hook `additionalContext`.

Advisory vs enforced: everything in 3–7 is **context**. Only hooks and `permissions.*` settings are
enforced by the client.

---

## 11. Graviton parity map

State of `ygg-chat/client/ygg-chat-r` on 2026-09-15 (branch
`fix/provider-stream-idle-timeout-persistence`).

### 11.1 What exists

| Area | Location | Notes |
| --- | --- | --- |
| Frontmatter parsing | `server/skills/skillManifest.ts:3` (regex split) + `yaml.parse` at `:37` | Requires `name` and `description`. Normalises `name` at `:14`. Reusable for rules/agents. |
| Skill loader | `server/skills/skillLoader.ts:258-277` | Reads `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` (parsed, never enforced). Global dir only: `<dataDir>/skills` (`:61-94`). One nested "group" level (`:197-218`). |
| Skill exposure | `shared/builtinToolDefinitions.ts:1069-1094` (`skill_manager` tool), `server/skills/skillManager.ts:43` | Model-pull only: `list` → `activate` returns the body **as a tool result**. No description index in the system prompt. |
| System prompt assembly | `server/headlessServer/services/headlessSystemPrompt.ts:149` `buildHeadlessSystemPrompt()` | Parts joined with `\n\n`: mode baseline → plan block → `requestPrompt` → `projectPrompt` (DB `projects.system_prompt`) → `conversationPrompt` (DB `conversations.system_prompt`). Single caller `chatOrchestrator.ts:889-903`. |
| Project root | `chatOrchestrator.ts:626-637`, `:995` | `request.rootPath ?? conversation.cwd`. `project.cwd` exists in the schema but is not in the chain. |
| Hook context | `server/headlessServer/services/chatHookService.ts:55-71`, `:347-359`, `toolLoopService.ts:1142-1146` | `additionalContext` → `[Hook context]` blocks appended to the system prompt. **Buffer clears every turn.** Events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` (`server/hooks/hookTypes.ts:1`). Config in `<dataDir>/.ygg/settings.json`, not per project. |
| Tool handler seam | `server/builtinToolRegistry.ts:44-57` | Every tool handler receives `rootPath`. `server/toolPathPolicy.ts:15` resolves every tool path. |
| Subagents | `shared/builtinToolDefinitions.ts:1096-1136`, `server/headlessServer/services/subagentToolExecutor.ts:54-103` | Free-text `systemPrompt` argument. No agent types, no `.md` definitions. Default tool list hardcoded at `server/headlessServer/index.ts:155-168`. |
| Memory files | `server/routes/memoryRoutes.ts:22-24,178`, `src/features/chats/chatActions.ts:625` | Renderer-only injection. Not ported to the headless loop (`chatHookService.ts:15-18`). Keyed by project name, not path. |

Stale docs found on the way: `docs/agent_context/agent_skills.md` points at
`client/ygg-chat-r/electron/skills/`; the code is under `client/ygg-chat-r/server/skills/`.
`agent_hooks_system.md:32` points at `electron/headlessServer/...`; it is `server/headlessServer/...`.

### 11.2 Gaps, one per Claude Code rule

The "Graviton status" column below describes the state **before** the 2026-09-15
implementation. Section 11.6 records what shipped and what is still open.

| Claude Code rule | Graviton status | Attach point |
| --- | --- | --- |
| §2 + §2.7 ancestor-chain instruction files at launch, filename set `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.local.md`, `CLAUDE.local.md` | Missing | New loader called in `chatOrchestrator.ts` between `:637` (root known) and `:889` (prompt built). Add a `projectInstructions` part to `buildHeadlessSystemPrompt`. Must land in **both** `systemPrompt` and `agentSystemPrompt` (plan→execute swap at `toolLoopService.ts:1358`). Per-directory order and real-path dedupe per §2.7 rules 2 and 4. |
| §2.3 `@path` imports, 4 hops, code-span exclusion, external approval; same in `AGENTS.md` | Missing | Same loader. External-import approval: `decisionBroker` card, once per root (decision 5, open). |
| §2.4 delivered as a user-side message with `Contents of <path> (...)` labels | Missing | Build once per conversation. Persist as a real user message with `meta.kind = 'context_injection'` (decision 6). Add the `meta` column and `Message.meta` field. Heimdall filter toggle. Never rebuild it per iteration (§11.5). |
| §2 nested `AGENTS.md` / `CLAUDE.md` lazy load (the standard's "closest file wins") | Missing | Wrap read and edit tools in `builtinToolRegistry.ts` (decision 4). Append the file as a `context_injection` content block on the triggering tool result (decision 7), not to the system prompt (§11.5). "Already loaded" set is derived from the active branch path, keyed by real path. |
| §3 unconditional rules | Missing | Same loader as §2, after CLAUDE.md, user rules before project rules. |
| §3 path-scoped rules, glob budget, symlink handling | Missing | Same read-tool seam as nested CLAUDE.md. Glob library must support `**`, braces, brackets, root anchoring. |
| §4 `MEMORY.md` 200 lines / 25 KB under `<dataDir>/.ygg/memory/projects/<slug>/` | Partial (renderer only, name-keyed, tail-truncated) | Port `maybeLoadMemoryContexts` into the headless loop; key by repo root slug; head-read 200 lines / 25 KB; add `modified` stamp. Mapping table in §4.2. |
| §5.1 project `<configDir>/skills` + nested path-qualified names | Missing (global dir only) | Extend `skillLoader.ts` with per-conversation project scan over every `readDirs` entry (§11.4); precedence enterprise > personal > project > nested. |
| §5.2 full frontmatter | Partial | Add `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `context`, `agent`, `background`, `paths`. Parse `allowed-tools`, `disallowed-tools`, `hooks`, `shell` but do not act on them. Ignore `model` and `effort` (decision 12). **TODO** (decision 8): enforce `allowed-tools` / `disallowed-tools`, register `hooks`. |
| §5.3 description index in the system prompt, 1,536-char cap | Missing | New `skillsIndex` part in `buildHeadlessSystemPrompt`. Exclude `disable-model-invocation: true`. |
| §5.4 body as a conversation message; dedupe; compaction re-attach | Partial (body arrives as a tool result) | Keep `skill_manager activate` but render through the §5.4 pipeline and add re-attach to the compaction path. |
| §5.5 argument and `${CLAUDE_*}` substitutions | Missing | Renderer step inside `skillManager.ts:60-86`. |
| §5.6 `` !`cmd` `` dynamic shell injection | **TODO** (decision 8) | Not implemented. Leave the `` !`cmd` `` text in place. Requires the trust gate first. |
| §5.7 `paths` on skills | Missing | Same seam as path-scoped rules. |
| §5.8 `context: fork` / `agent:` | Missing | Route through `subagentToolExecutor.ts` with the body as prompt. |
| §6 agent `.md` definitions, precedence, validation, startup context | Missing | New `agentLoader` over `<root>/<configDir>/agents/**` for each `readDirs` entry (reuse `skillManifest.ts` parser). Add `agent_type` to the `subagent` tool schema. Publish the agent index in the system prompt. Ignore `model` and `effort`; the subagent runs on the user's Settings model (decision 12). |
| §6.4 subagent receives CLAUDE.md unless `omitClaudeMd` | Missing | Reuse the §2 loader in `buildSubagentRequest()`. |
| §9 new events `SessionStart`, `PreCompact`, `InstructionsLoaded` | Partial | Add events to `hookTypes.ts` and fire them from the loader and `compactionService.ts`. Config stays in `<dataDir>/.ygg/settings.json`. |
| §9 per-project hook config `<root>/<configDir>/settings.json`, frontmatter `hooks:`, `once` | **TODO** (decision 8) | Not implemented. Requires the trust gate first. |
| §9.4 `additionalContext` placement | Different: folded into the system prompt per iteration and cleared (`chatHookService.ts:511-515`, `toolLoopService.ts:1142-1146`) | Move to the transcript tail: append to the newest user message (UserPromptSubmit) or to the triggering tool result (PreToolUse, PostToolUse, PostToolUseFailure). Retire `systemPromptOverride` for hook output. Rationale in §11.5. |

### 11.3 Decisions for Graviton

These are product decisions, not Claude Code rules. All decided 2026-09-15 unless marked open.

1. **Primary filename.** Follow the open standard. Read `AGENTS.md` and `CLAUDE.md` with identical
   rules, `AGENTS.md` first in each directory, real-path dedupe. No Graviton-specific filename. Full
   rules in section 2.7.
2. **Config directory name.** A user setting, not a constant. Graviton-owned state in the data dir
   stays under `<dataDir>/.ygg/` (section 4). The in-repo directory that holds `rules/`, `skills/`,
   `agents/`, `settings.json`, and agent memory is chosen in Settings: `.ygg`, `.claude`, both, or a
   custom list. Specification in section 11.4.
3. **Delivery position.** The system prompt is immutable after the first provider call of a
   conversation. Launch-time content goes in once. Everything injected later goes to the transcript
   tail. Rules in section 11.5.
4. **Trigger tools for lazy loads.** **Open.** Recommendation: Read tools (`read_file`, `read_files`)
   plus edit tools (`edit_file`, `multi_edit`, `create_file`). Not search tools (`ripgrep`, `glob`,
   `directory`).
5. **Approval UX for external imports and symlinked rules.** **Open.** Recommendation: the same
   `decisionBroker` approval card used for tool approvals, asked once per root and remembered.
6. **Launch-time instruction files are a persisted user message with `meta`.** Deliver the section 2
   set as a real user message directly after the system prompt, like Claude Code. Because Graviton
   persists messages in the `messages` table and renders them in Heimdall, add a generic
   `meta TEXT` column (JSON, `Record<string, unknown>`) to `messages` and a `meta?: Record<string,
   unknown>` field to the `Message` type in `src/features/chats/chatTypes.ts`. The loader writes
   `meta.kind = 'context_injection'` plus `meta.files = [<abs paths>]`. Heimdall's existing
   rendering-only filter (`Heimdall.tsx:2044`, "Hide Empty Messages") gains a sibling toggle that
   hides messages with `meta.kind === 'context_injection'`. Future identifiers go in `meta` as new
   keys, not as new columns. Nothing else reads `meta` yet.
7. **Lazy injections are persisted content blocks on the active branch.** Append a lazy file, rule,
   or hook `additionalContext` to the triggering tool result as a dedicated content block type,
   `context_injection`, with `path`, `label`, and `text`. Derive the "already loaded" set from the
   `context_injection` blocks and `meta.kind === 'context_injection'` messages on the **active branch
   path** at request-build time. No session-global set. Editing an earlier message and regenerating
   therefore starts a branch with the correct loaded set.
8. **Repo-sourced code execution is out of scope for now. TODO.** Graviton has no `` !`cmd` ``
   injection and no `allowed-tools` enforcement today. The plan does **not** implement: `` !`cmd` ``
   and ```` ```! ```` blocks in skills (section 5.6), `allowed-tools` / `disallowed-tools` grants
   from repo skills, per-project hook config from `<root>/<configDir>/settings.json`, frontmatter
   `hooks:` in skills and agents, or a workspace trust dialog. When any of these is picked up, add
   the trust gate first: a per-root trust flag asked once via `decisionBroker`; until trusted, load
   instruction files and rules but run no repo-sourced hooks or shell commands. Section 11.2 marks
   the affected rows TODO.
9. **User scope follows `readDirs`.** Read `~/<readDir>/AGENTS.md`, `~/<readDir>/CLAUDE.md`,
   `~/<readDir>/rules/**`, `~/<readDir>/skills/*/SKILL.md`, and `~/<readDir>/agents/**` for each
   `readDirs` entry, in order. Selecting `.claude` shares an existing Claude Code setup unchanged.
   The data dir `.ygg` holds memory and hooks config only. Supersedes section 2.7 rule 7.
10. **Installed skills are the personal scope.** `<dataDir>/skills` (Settings UI installs, with
    `.skill-meta.json` `enabled`) is read as the personal scope beside `~/<readDir>/skills`. Project
    and nested skills have no meta file and are enabled by default. `disable-model-invocation` and
    `user-invocable` control exposure. `skillOverrides` can be added later for per-project disabling.
11. **Tool name aliases.** A fixed alias table in `shared/` maps Claude Code tool names to Graviton
    tool names when parsing `tools`, `disallowedTools`, `allowed-tools`, `disallowed-tools`, and hook
    `matcher` values. Initial table: `Read` → `read_file`, `read_files`; `Grep` → `ripgrep`; `Glob` →
    `glob`; `Bash` → `bash`; `Edit` → `edit_file`, `multi_edit`; `Write` → `create_file`; `Agent` →
    `subagent`; `Skill` → `skill_manager`; `WebFetch`, `WebSearch` → the Graviton equivalents when
    present. Unknown names pass through unchanged with a debug warning.
12. **No model switching from skills or agents.** Graviton ignores the `model` field in skill and
    agent frontmatter, and the `effort` field with it. The subagent model is a user setting in
    `src/containers/Settings.tsx` (the "Subagent model" picker, normalised by
    `src/helpers/subagentModelNames.ts`). Every subagent runs on that model; every skill runs on the
    conversation model. Unknown or ignored keys are accepted per section 1, so shared files still
    parse. Log one debug line when a file carries `model:` or `effort:`. Superseded rows in
    sections 5.2 and 6.2 remain as Claude Code reference only.
13. **Operation modes.** Load instruction files, rules, and the skill and agent indexes in chat, plan,
    and execute modes whenever the conversation has a `rootPath`. Lazy path-scoped loads fire only in
    modes that expose read or edit tools.
14. **Loader independence from `hooksEnabled`.** The loader runs whenever `rootPath` is set. It reads
    `contextDirectories` from the request and falls back to the server env defaults. It does not
    depend on `hooksEnabled`, `hookRunner`, or `decisionBroker` being present.

**Why Claude Code has the `model` field.** A skill's `model:` overrides the session model for the turn
that runs the skill; an agent's `model:` sets that subagent's model. It is a cost lever: an `Explore`
agent on `haiku` while the main session stays on a larger model. Graviton replaces this with the
single user-chosen subagent model (decision 12).

### 11.4 Config directory setting

Every rule in sections 3, 5, 6, and 9 that names `.claude/` reads `<configDir>/` in Graviton, where
`<configDir>` comes from this setting. Instruction files (section 2.7) are **not** affected: `AGENTS.md`
and `CLAUDE.md` sit at the directory root, and `.claude/CLAUDE.md` is kept as a fixed compatibility
path.

**Setting shape.**

```ts
interface ContextDirectorySettings {
  /** Ordered list of in-repo directory names to READ. Deduped by real path. */
  readDirs: string[]          // default: ['.ygg', '.claude']
  /** Single directory name to WRITE (agent memory, generated rules/skills). Must be in readDirs. */
  writeDir: string            // default: '.ygg'
}
```

| Preset in the UI | `readDirs` | `writeDir` |
| --- | --- | --- |
| `.ygg` only | `['.ygg']` | `.ygg` |
| `.claude` only | `['.claude']` | `.claude` |
| Both (default) | `['.ygg', '.claude']` | `.ygg` |
| Custom | User-entered names, one per row, drag to order | User picks one of the rows |

Validation for custom names: one path segment, no `/`, `\`, `..`, or leading `~`; 1 to 64
characters; a leading `.` is allowed but not required. Reject duplicates after trimming. The write
directory must be one of the read directories.

**Read semantics with more than one directory.**

- Discovery runs the same algorithm once per name, in `readDirs` order, inside every directory the
  section 2 walk visits. So for `readDirs: ['.ygg', '.claude']` and a rule scan of `<dir>`, Graviton
  reads `<dir>/.ygg/rules/**/*.md` then `<dir>/.claude/rules/**/*.md`.
- Injection order follows `readDirs` order within one filesystem directory. Across directories the
  section 2.2 root-first order still wins.
- Skills, agents, and rules with the same `name` in two config directories: the **first** `readDirs`
  entry wins. Both stay listed in `/context`-style diagnostics with their full path.
- Real-path dedupe (section 2.7 rule 4) applies, so `.claude -> .ygg` symlinks load once.
- `claudeMdExcludes`-style patterns match absolute paths and therefore work for any directory name.

**Write semantics.** Only `writeDir` receives new files: `agent-memory/`, `agent-memory-local/`,
and anything a future "save as rule/skill" action creates. Reads never write.

**Storage and plumbing.**

| Layer | Location | Notes |
| --- | --- | --- |
| Renderer helper | new `src/helpers/contextDirectorySettingsStorage.ts` | Same pattern as `src/helpers/longTermMemorySettingsStorage.ts`: `localStorage` key `chat:contextDirectories`, a load function with defaults, a save function that dispatches a change event. |
| UI | `src/containers/Settings.tsx` | New section "Context files" beside the existing memory toggle. A four-way radio (`.ygg`, `.claude`, Both, Custom), a list editor shown for Custom, and a write-directory picker. Show the resolved read order as a preview line. |
| Request | chat send/edit/branch requests in `src/features/chats/chatActions.ts` (the three sites that set `hooksEnabled`, `:1549`, `:2126`, `:2377`) | Add `contextDirectories: ContextDirectorySettings` to the request body. |
| Server | `chatOrchestrator.ts` near `:626-637` | Read `request.contextDirectories`, fall back to the defaults when absent, pass to the loader and to `buildSubagentRequest()` so subagents inherit it. |
| Server default | `server/serverConfig.ts` | Optional `YGG_CONTEXT_DIRECTORIES` env (comma list) and `YGG_CONTEXT_WRITE_DIRECTORY` for headless runs without a renderer. Request value overrides env. |

The setting is per user on this machine, like the other `localStorage` preferences. It is not stored
in the repo, so two developers on one repo may read different directory sets. That is intended: the
repo can ship both `.claude/` and `.ygg/` and each tool reads what it understands.

### 11.5 Prompt-cache rule: the system prompt is immutable

Provider prompt caching (Anthropic, OpenAI, and OpenRouter pass-through) caches a **prefix** of the
request. The prefix starts at byte 0 of the system prompt and runs through tool definitions into the
message history. A cache hit requires every byte before the cache point to be identical to the
previous call. Any change to the system prompt moves the first differing byte to the start of the
request and invalidates the whole cached prefix. The next call re-bills every token of tool
definitions and history at the uncached input price and pays full processing latency.

**Current Graviton behaviour and its cost.** `foldSystemPrompt` (`chatHookService.ts:511-515`)
appends `[Hook context]` blocks to the base system prompt for one iteration, then the loop clears the
buffer (`toolLoopService.ts:1146`). The system prompt therefore differs between iteration N and N+1
whenever a hook returned text, and differs again at N+2 when the buffer is empty. Each flip drops the
cache for the entire transcript. A PostToolUse hook that returns text on most tool calls makes most
iterations of a long loop run uncached.

**Claude Code behaviour.** The system prompt never changes after session start. All runtime
injection lands at the tail of the transcript, after the last cache point:

| Content | Where Claude Code puts it |
| --- | --- |
| Launch-time CLAUDE.md set, rules, `MEMORY.md` | A user message directly after the system prompt, built once. The system prompt itself is identical across sessions and caches across sessions. |
| Hook `additionalContext` from UserPromptSubmit | A `<system-reminder>` block appended to that user message. |
| Hook `additionalContext` from PreToolUse / PostToolUse | Appended to the tool result of that tool call. |
| Nested CLAUDE.md, path-scoped rules, path-scoped skills | A `<system-reminder>` next to the Read tool result that triggered them. |
| Skill bodies | A message in the conversation. |
| Compaction re-injection | Rebuilt into the post-summary context, once. |

A tail block is permanent history until compaction. It cannot be "cleared" on the next iteration.
For instruction files this is the desired sticky behaviour. For hook output it means a noisy hook
costs tokens once per firing, not once per iteration, and the per-entry cap
(`MAX_HOOK_CONTEXT_CHARS`) still bounds each block.

**Rules for the Graviton implementation.**

1. Build the system prompt once per conversation: mode baseline, request/project/conversation
   prompts, skill index, agent index. Do not change it between iterations. The plan→execute swap at
   `toolLoopService.ts:1358` is the one accepted exception; it happens once.
2. Deliver the launch-time instruction set (section 2) as one persisted user message directly
   after the system prompt, built once per conversation, tagged `meta.kind = 'context_injection'`
   (decision 6). Its content must be deterministic for the conversation so the cached prefix holds.
3. Route hook `additionalContext` to the transcript tail: UserPromptSubmit output onto the current
   user message; PreToolUse, PostToolUse, and PostToolUseFailure output onto the corresponding tool
   result; Stop output onto the next user message.
4. Route lazy instruction files, path-scoped rules, and path-scoped skills onto the tool result that
   triggered them, with the section 2.4 label.
5. Retire `systemPromptOverride` for hook output. Keep the code path only if a provider without
   prefix caching needs it, behind an explicit flag, default off.
6. Keep the skill and agent indexes stable within a conversation. Reloading skills mid-conversation
   (the `/api/skills/reload` route) may change the index; apply the new index from the next
   conversation, or accept one cache miss and document it.
7. Compaction is the one point where the prefix legitimately changes. Rebuild the tail content there
   as section 2.6 and section 5.4 describe.

### 11.6 Implementation status (2026-09-15)

Operational detail lives in `docs/agent_context/agent_context_loading.md`. Paths below are
relative to `client/ygg-chat-r/`.

| Rule | Status | Where |
| --- | --- | --- |
| §1 frontmatter envelope, booleans, lists, HTML comment stripping, 4 MiB cap | Implemented | `server/context/frontmatter.ts`, `server/context/instructionFiles.ts` |
| §2 / §2.7 launch chain (`AGENTS.md`, `CLAUDE.md` or `.claude/CLAUDE.md`, `.local.md`), root-first order, real-path dedupe, `@AGENTS.md`-only skip | Implemented | `server/context/instructionFiles.ts` `discoverLaunchInstructionFiles` |
| §2.3 imports, 4 hops, code-span exclusion, user-scope without dialog | Implemented | `expandImports`, `extractImportTokens` |
| §2.3 external import approval | Partial (decision 5) | Loads under the auto-approve tool policy; skipped and logged under the interactive policy. `chatOrchestrator.ts` `approveExternalImports` |
| §2.4 delivery as a user-side message with labels | Implemented | Persisted user row, `meta.kind = 'context_injection'`; `shared/contextInjection.ts` `renderInstructionSet` |
| §2.2 step 3 nested lazy load; §3.4 path-scoped rules; §5.7 skill `paths`; nested skills | Implemented | `server/context/contextLoader.ts` `collectLazyInjections`, `toolLoopService.ts` tool-result blocks |
| §2.5 `claudeMdExcludes` | Implemented | Read from `<dataDir>/.ygg/settings.json`, `~/<readDir>/settings.json`, `<root>/<readDir>/settings.json` (+ `.local.json`) |
| §2.6 compaction re-injection; §5.4 skill re-attach 5,000 / 25,000 tokens | Implemented | `buildPostCompactionInjection`, `toolLoopService.ts` after `compactBranch` |
| §3 rules: recursive, symlinks, circular detection, external rules gate, glob budget | Implemented | `server/context/rulesLoader.ts`, `server/context/globMatcher.ts` |
| §4 `MEMORY.md` 200 lines / 25 KB, repo-root slug, `autoMemoryEnabled`, `autoMemoryDirectory`, env toggles | Implemented | `server/context/autoMemory.ts`; memory prompt in the system prompt |
| §4 `modified` frontmatter stamp on write | Not applicable | Graviton has no server memory write route; the model writes files with the edit tools |
| §5.1 scopes personal > project > nested, legacy commands, collisions listed | Implemented | `server/context/skillsDiscovery.ts`, host installs as personal scope (decision 10) |
| §5.2 frontmatter (all keys parsed; `allowed-tools`, `hooks`, `shell` not acted on; `model`, `effort` ignored) | Implemented | `parseSkillFrontmatter` |
| §5.3 description index, 1,536-char cap, `disable-model-invocation` | Implemented | `renderSkillIndex` → `buildHeadlessSystemPrompt` `skillsIndex` |
| §5.4 body as a conversation message; `/name args` from the user | Implemented | `skill_manager activate` body → `context_injection` block; slash expansion on the user row |
| §5.5 substitutions and escapes | Implemented | `renderSkillBody` |
| §5.6 `` !`cmd` `` | TODO (decision 8) | Text left in place |
| §5.8 `context: fork` | Not implemented | Parsed; the model uses the `subagent` tool directly |
| §6 agent definitions, validation, closest-wins, index, `agent_type` on `subagent`, `tools`, `disallowedTools`, `skills`, `maxTurns`, `memory`, `omitClaudeMd` | Implemented | `server/context/agentsLoader.ts`, `subagentToolExecutor.ts`, `subagentRunService.ts` |
| §6.4 subagent receives instruction files | Implemented | In the subagent system prompt |
| §7 output styles, §8 plugins, managed policy | Not implemented | — |
| §9 `SessionStart`, `PreCompact`, `InstructionsLoaded` events and matchers | Implemented | `server/hooks/hookTypes.ts`, `hookRunner.ts`, `chatHookService.ts` |
| §9.4 `additionalContext` to the transcript tail | Implemented | `toolLoopService.ts` `hookContextPlacement: 'transcript'` (legacy fold behind `'system_prompt'`) |
| §11.4 context directory setting | Implemented | `shared/contextDirectories.ts`, `src/helpers/contextDirectorySettingsStorage.ts`, Settings "Context files", request field `contextDirectories` |
| Decision 6 `meta` column | Implemented | Schema migration v2 `messages_meta_column` (`server/MIGRATIONS.md`) |
| Decision 7 `context_injection` block, branch-derived loaded set | Implemented | `shared/contextInjection.ts` |
| Heimdall filter, compact rows | Implemented | `Heimdall.tsx` toggle, `Chat.tsx`, `ChatMessage.tsx` |
| Renderer `/` menu for user-invocable skills | Not implemented | Server-side expansion only |

---

## Maintenance

- Re-verify against the docs URLs at the top before each Graviton implementation phase. Version
  gates in this document (`vX.Y.Z+`) come from the docs and may move.
- Anything marked **observed** must be re-checked against a live session before it becomes a test
  fixture.
- When Graviton implements a row of §11.2, move the row to §11.1 with the new file and line.
