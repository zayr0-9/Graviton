# Changelog

All notable changes to `client/ygg-chat-r` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Historical gaps have been reconstructed from Git tags, app-version changes, and implementation diffs. Backfilled dates identify tag-target or version-change commits, not independently verified publication dates. Skipped version numbers are not inferred as releases; changes between version bumps are grouped under the next recorded version. The 0.2.3 entry includes changes through its June 28 tag target.

## [Unreleased]

### Added

- Added an experimental attached-browser build of the shared Electron UI, with shared host identity/settings, multi-observer run recovery, queue/decision controls, independent host terminals and a phone workspace panel. This trusted-network preview has no device authentication; physical-device acceptance and legacy-mobile retirement remain pending.
- Added draggable dividers for resizing agent-monitor grid cards within each row.

### Changed

- Refreshed searchable select dropdowns and the sign-in screen with theme-aware styling.
- Matched the floating agent monitor's accent to the theme's streaming color.

### Fixed

- Cleared both local and stored composer drafts after sending so submitted text does not reappear, while preserving attached images for the request.
- Restored focus to select controls after selection or dismissal and prevented keyboard selection of disabled options.
- Kept Heimdall selection and visibility highlights readable when zoomed out.
- Rendered compaction summaries consistently in agent previews.

## [0.3.19]

Pending release.

### Added

- Added ChatGPT output-token throughput to run statistics and widened the statistics footer.
- Added separate theme colors for streaming and idle agent-monitor cards.

### Changed

- Routed manual and automatic compaction through the normal server turn pipeline, with explicit compaction metadata and shared summary handling across chat and subagent runs.
- Improved theme-aware Markdown rendering, scrollable tables, message notices, and agent-monitor previews.

### Fixed

- Hardened chat selection and snapshot coordination against stale asynchronous updates and rapid navigation.
- Followed watcher continuations only when their originating branch remains selected, without stealing navigation from another conversation.
- Resolved branch model selection from the selected message's ancestry instead of unrelated conversation messages.
- Kept compaction control messages out of normal chat and graph presentation while preserving committed summaries for context and persistence.
- Prevented duplicate message submissions and kept clarification controls usable in compact layouts.

## [0.3.18] - 2026-10-12

### Fixed

- Prevented conversation snapshot races from blocking chat selection, including stale in-flight requests and snapshot application during navigation.

## [0.3.17] - 2026-10-11

### Fixed

- Set the desktop release build's Node heap limit directly on the build step instead of writing `NODE_OPTIONS` to `GITHUB_ENV`, where GitHub Actions disallows it.

## [0.3.16] - 2026-10-11

### Added

- Added per-run statistics showing duration, tool-call counts, and estimated input/output tokens.

### Changed

- Refreshed file-edit previews with collapsible summaries, line-change counts, and inline/split view controls.
- Lazy-loaded the Monaco workspace instead of eagerly importing editor and Git-diff modules.
- Enabled SQLite WAL with `synchronous=NORMAL` and WAL checkpointing on close.
- Built hook metadata lazily and queried only message lineage fields for ancestry checks.

### Fixed

- Centralized chat selection and guarded pending streams and asynchronous callbacks by selection revision to prevent stale navigation and branch updates.
- Replaced full startup search-index rebuilds with a one-time migration and rowid-targeted index deletion.

## [0.3.15] - 2026-10-10

### Added

- Added a session-based, branch-shared JavaScript `repl` for capturing tool results, processing data, and revealing selected output, with explicit JSON artifact import/export.
- Added asynchronous branch watchers for process exits, file/log conditions, and HTTP readiness; completion can continue the same branch and display a notification.
- Added queued follow-up messages during active runs and instructions to detached subagents through `subagent_manager.send`, with delivery status and request deduplication.
- Added `context_status` and shared branch token accounting, preferring reported OpenAI usage and excluding image payloads from text estimates.
- Added fork-based agent monitoring groups, grid/list views, resizable panels, and run/full-fork previews.
- Added live Chat/Agent mode changes and a redesigned conversation toolbar with title editing and clone confirmation.
- Added ChatGPT priority service-tier support and configurable Fast Mode animations; recognized additional GPT-6-family variants.

### Changed

- Consolidated API-key and MCP secrets into one credential vault, with an explicit verified migration flow.
- Switched to project Markdown memory indexes instead of legacy aggregate-memory APIs, the memory browser, `memory_manage`, and the Stop-hook writer; existing memory files remain for manual migration.
- Improved Heimdall project grouping, note-color controls, context-menu selection, and docked preview layout; added composer sent-message history navigation.

### Fixed

- Preserved the selected ChatGPT model instead of silently substituting another, and hydrated stored image attachments for subsequent model requests, including LM Studio vision inputs.
- Kept completion notifications tied to the exact agent execution and hardened MCP OAuth discovery, cancellation, callback handling, and credential updates.

## [0.3.9] - 2026-09-20

### Added

- Added a saved stream idle timeout, defaulting to two minutes and adjustable from 45 seconds to 10 minutes.

### Fixed

- Preserved running-agent conversation titles and parent-message previews when navigating between conversations.
- Preferred current-route conversation title edits over stale global metadata.
- Bounded glob searches with cancellation, deadlines, and match limits; resolved Linux paths correctly on Windows.
- Hardened ripgrep execution with bounded output, cancellation, and native Windows/WSL command handling.

## [0.3.8] - 2026-09-18

### Added

- Added automatic loading of repository instructions, imported instruction files, path-scoped rules, skills, agent definitions, and project memory, with visible context-loading cards.
- Added configurable context read/write directories, including `.ygg` and `.claude` presets.
- Added project `MEMORY.md` index loading and a persistent Markdown memory directory for agents.
- Added named agent-definition launches with system prompts, tool restrictions, preloaded skills, and agent-specific memory.
- Added durable hook activity and diagnostics in chat, including asynchronous hook completion.
- Added interactive Mermaid diagrams with pan, zoom, and expanded viewing.

### Changed

- Reloaded repository context and activated skills after compaction.

### Fixed

- Centralized account sessions and token refresh, with one ChatGPT authentication retry before any output is emitted.
- Bounded Bash and PowerShell preparation/execution time and cleaned up timed-out processes while retaining captured output.

## [0.3.4] - 2026-08-23

### Added

- Added a standalone Node server entry point and shared server initialization independent of Electron.
- Added clearer in-chat error notices with actionable recovery controls and retry timing.
- Added skill installation from GitHub repositories and individual skill folders.

### Changed

- Separated the server runtime from desktop host capabilities; the standalone server defaults to loopback binding and restricted CORS.

## [0.3.3] - 2026-08-08

### Added

- Added feature-gated resumable server-run stream replay and reattachment infrastructure.

### Changed

- Moved the main chat agent loop to the server, including tool permissions, clarification pauses, hooks, branching, and persistence.

### Fixed

- Preserved bounded tool arguments and results, including subagent output, through context compaction.

## [0.2.8] - 2026-07-25

### Added

- Added mid-run automatic compaction for OpenAI/Codex tool loops near the context limit so work can continue without another user message.

### Changed

- Moved subagent execution to the headless server using the shared tool loop, persisted transcripts, and streamed lifecycle updates.

## [0.2.6] - 2026-07-19

### Added

- Added editable Agent Mode and subagent system prompts with local overrides and reset-to-default controls.

### Changed

- Polished settings, agent status controls, and panel transitions, including reduced-motion support.

### Fixed

- Fixed Heimdall hover previews flickering or blocking graph interactions through invisible hit areas.

## [0.2.5] - 2026-07-19

### Added

- Added local persistence of attached images before generation so agents can inspect them immediately with `view_image`.
- Added OpenAI provider-reported context usage and context-usage visualization.

### Changed

- Kept large image and tool payloads out of persisted chat history while retaining them in model input.
- Reduced per-token rendering work and rendered the live streaming tail outside the message virtualizer.

### Fixed

- Fixed streaming scroll jumps, auto-follow behavior, and conversation-load positioning.
- Fixed LM Studio streaming state leaking between tool-loop turns.
- Fixed remote MCP OAuth credential persistence and authentication-state refresh across reconnects.

## [0.2.4] - 2026-07-01

### Changed

- Enabled remote access to the local server by default on all desktop platforms, rather than Windows only.

## [0.2.3] - 2026-06-28

### Added

- Added multi-edit support to the `todo_list` tool so multiple checklist items can be updated in one tool call.
- Added an Electron runtime memory viewer in Settings, including markdown rendering for global, recent, and project memory files.
- Added undo for file edits made with `edit_file` and `multi_edit`, with per-response backups and conflict detection before restoring.
- Added copying or moving selected Heimdall messages and branches to an existing chat as a new top-level chain.
- Added a local project working directory inherited by new local chats; existing chats retain their own working directories.
- Added locally saved reusable system prompts alongside cloud prompts, with storage selection and default-prompt controls.
- Added Plan mode response verbosity settings, streaming-thinking indicator placement controls, and an attached-file pill visibility toggle.
- Added tool-batching and saved-call statistics to logging analytics.
- Added separate Subagent Provider and Subagent Model selectors in Settings.

### Changed

- Improved `read_files` output with a normalized combined content view, structured per-file metadata, and consistent error reporting.
- Improved `@file` mention search ranking so exact filename matches appear ahead of directory and broader path matches.
- Updated the chat input panel styling by removing the outer drop shadow.
- Refreshed settings, project editing, and chat action popovers with theme-aware styling and animations; changed the default font to Geist with Ubuntu fallbacks.
- Moved local analytics queries into a dedicated background worker.
- Made plan creation return a concise confirmation instead of echoing the entire plan back to the model.
- Changed the default subagent model to GPT-5.4 Mini.
- Subagent defaults now use subagent-specific settings instead of the Global Agent model.
- Reduced the width of composer provider and model selectors.

### Fixed

- Fixed extra bottom padding on assistant messages that made streamed reasoning blocks appear taller than persisted messages.
- Fixed subagent responses leaking literal `<thinking>` blocks back into parent model output.
- Fixed headless OpenAI ChatGPT requests by ensuring non-empty instructions are always sent.
- Fixed tool cwd handling so empty, `.`, and `/` cwd values resolve to the current tool process working directory.
- Fixed virtualized chat scrolling so large final streaming responses after tool execution no longer drag the viewport while the user is reading.
- Reverted Linux rounded-corner transparency styling to avoid square native windows with rounded inner content artifacts.
- Fixed chat options closing when interacting with a nested select dropdown.
- Enforced operation-mode tool restrictions in headless chat execution as well as the renderer.
- Fixed missing Linux window controls by adding a custom titlebar for frameless desktop windows.

### Removed

- Removed the Hermes agent integration and its runtime settings.

## [0.2.2] - 2026-06-12

### Added

- Added Python hook execution fallback from `python` to `python3`.
- Added sign-in account stats for Codex.
- Added the `multi_call` tool for running multiple predictable tool calls sequentially.
- Added system prompt support in remote and headless mode.

### Changed

- Improved the `read_files` tool.
- Updated system prompts.
- Updated Bash and PowerShell tool cwd resolution so cwd values of `''`, `.`, or `/` are treated as the tool process `process.cwd()`.

### Fixed

- Fixed hook execution on systems where only `python3` is available.
- Added retries for Codex HTTP stream failures before the first response bytes arrive.
- Preserved partial OpenAI ChatGPT responses when a stream ends with an error.

## [0.2.1] - 2026-06-11

### Fixed

- Applied the release build memory limit to the entire desktop build job.

## [0.2.0] - 2026-06-11

### Added

- Added the interactive `plan_md` tool for creating, editing, displaying, and clarifying plans.
- Added bounded parallel execution of subagent tool calls.
- Added a dedicated default system prompt for subagents.

### Changed

- Changed Linux desktop packaging from AppImage to DEB.

## [0.1.99] - 2026-06-05

### Added

- Added an option to hide token-usage detail popups on hover.

## [0.1.98] - 2026-06-02

### Added

- Added Amazon Bedrock provider support through Hyper Router.
- Added customizable Chat mode system prompts, with saved prompt selection in Settings.

## [0.1.96] - 2026-05-26

### Added

- Added Z.AI/GLM provider support through Hyper Router, including API-key configuration in Settings.
- Added an OpenAI prompt-cache retention setting for in-memory or 24-hour caching.

## [0.1.95] - 2026-05-18

### Fixed

- Fixed OpenAI ChatGPT conversations stopping after the first tool call instead of continuing to the tool result and follow-up response.
- Fixed generated-image follow-up turns creating a parallel branch instead of continuing from the saved-image context.
- Fixed a freeze that could happen after image generation when local image filenames collided with existing files.
- Improved generated-image save handling so follow-up messages can reliably reference the locally saved image path.

## [0.1.94] - 2026-05-17

### Added

- Added OpenAI web search support for ChatGPT/Codex conversations.
- Added OpenAI image generation support.
- Added image viewing support so assistants can inspect locally saved generated images when needed.

### Changed

- Generated images are now saved locally with simpler filenames like `img-0001.png`.
- Follow-up chats can better remember where generated images were saved.
- Improved context estimation for chats that include generated images.

### Fixed

- Fixed generated images sometimes not appearing or not being saved.
- Fixed image-heavy chats incorrectly using too much context.
- Fixed generated-image helper messages showing up in the visible chat timeline.

## [0.1.93] - 2026-05-09

### Fixed

- Fixed branch-note creation for root-level branches without a parent message.

## [0.1.92] - 2026-05-09

### Added

- Added a PowerShell tool for native command execution.

### Changed

- Moved desktop OpenAI ChatGPT streaming and authentication checks into Electron.

## [0.1.91] - 2026-04-29

### Added

- Added GPT-5.5 and GPT-5.5 Pro model support.

### Fixed

- Prevented late stream events from updating conversations after abort or completion.
- Updated streamed tool results in place so final results replace earlier placeholders.

## [0.1.90]

### Changed

- remote server uses main app codex token

### Fixed

- codex 5.1 mini is defunct, switched to gpt 5.4 mini for summaries

## [0.1.89]

### Added

- Added a shared custom-tools `resources/` directory and loader safeguards.

### Changed

- Disabled vector search in fetch notes for now.

### Fixed

- Fixed tool colors in light mode.

## [0.1.88] - 2026-04-14

### Added

- Added MCP stdio framing auto-detection with content-length/newline-JSON fallback, plus Blender MCP compatibility and server env support.
- Added LM Studio provider URL override in Settings and synced it into the headless provider config.
- Added Windows Terminal curl examples for note embedding, upsert, and vector table configuration.
- Added a logout button to the top of Settings next to Home.

### Changed

- Subagent/provider routing now inherits caller context instead of leaking to OpenRouter.
- Explain-from-selection now always parents the new user message to the selected message, avoiding wrong-branch explains.
- Updated internal note/retrieval guidance around note-first memory, vector search, and lexical reranking.

### Fixed

- Fixed LM Studio server address handling so the client no longer depends on a static base URL.
- Fixed branch-parenting behavior for explain selection in the chat flow.

## [0.1.87] - 2026-04-09

### Changed

- Empty chats now show the selected project folder.

### Fixed

- Improved sidebar button contrast in light mode.

## [0.1.86] - 2026-04-04

### Added

- Added fetch chats, and Internal Link tool, to work as agent memory, and let you navigate
- Beta LSP integration with code editor

### Changed

- Switched several icons from box to lucid

### Fixed

- Linux background was transparent, causing it to become white, should be solid color now.
- Fixed reasoning disappearence due to OAI responses shape change

## [0.1.85] - 2026-04-04

### Added

- Added native GitNexus custom-tool integration and GitNexus-first agent workflow guidance.

### Changed

- Removed the default gfish video background and changed the app default to a transparent solid background.
- Updated Electron runtime and taskbar icon usage to the graviton-dark assets.

### Fixed

- Fixed local-mode project and conversation creation by ensuring the local user exists before foreign-key-constrained inserts.

## [0.1.84] - 2026-04-01

### Added

- Added built-in terminal support via xterm.js.
- Added a terminal column in the right bar.
- Added OpenAI sign-in in Settings.
- Added a fallback for @-mentions when the extension is unavailable.
- Added an appendix system to manually attach edited files during compactify.
- Added built in browser in the right sidebar, dev tools available can be enabled/disabled in settings.
- Added multi-edit tool, added ui card for it.

### Changed

- Streaming animation is now visible.
- Reasoning defaults are now on with high effort.
- Editor tabs are now fully clickable with better accessibility.
- Compactify summaries now exclude tool-call text from the generated summary.
- New users now get a default project and chat and open directly into the app.

### Fixed

- Improved light theme terminal contrast for readability.

## [0.1.83] - 2026-03-29

### Added

- Added `/theme-demo on` and `/theme-demo off` slash commands to cycle through installed custom themes for demo recording.
- Added branch-point prompt injection support so the current parent/ancestor id can be inserted before a user message is sent.
- Added estimated token display in LoggingPage based on message character counts.
- Added branch-aware Hermes ACP support, with separate runtime sessions for branch lineages.

### Changed

- Expanded theming coverage across more UI surfaces, including composer toggles, auth, HTML tools, Heimdall modals, and context pills.
- Updated Arctic Aurora to support the newly themeable UI elements.
- Improved chat message rendering behavior and animations for newly arriving messages and branch activity indicators.
- Simplified subagent/provider handling so ChatGPT/OpenAI can force the OpenAI provider and use the configured default agent model.
- Logging analytics now aggregate character counts server-side and expose `estimatedTotalTokens`, with the daily chart respecting the selected date range.

## [0.1.82] - 2026-03-25

### Added

- Added a right-sidebar code editor, file search, and Git integration.
- Added lifecycle hooks for message submission, tool execution, and agent completion.
- Added an Agents panel showing active streams and recent session history.

### Fixed

- Made stream selection follow the selected branch instead of unrelated active streams.

## [0.1.81] - 2026-03-07

### Added

- Added a headless chat backend with server-side provider dispatch, conversation persistence, tool execution, and a mobile web interface.

## [0.1.79] - 2026-02-23

### Added

- auto summarisation added
- solid background support
- custom font support
- sidebar shows messages in each chat in popover list

### Changed

- sidebar makeover
- edit file optimised
- cwd change sent as user message

### Fixed

- fixed readme build instructions
- textfiled font size is now smaller when branching
- Html Tools modal now shows app names in Favorites and Hibernated lists (in addition to IDs), matching opened app visibility in the top tabs.
- create new chat carries over cwd now.

## [0.1.78] - 2026-02-23

### Added

- new tool runtime (isolated in an electron utility worker now instead of main render thread) [if building yourself: in client/.env add YGG_TOOLS_RUNTIME=utility and DISABLE_TOOL_RUNTIME_FALLBACK=true if you dont fall back]

### Changed

- Moved settings button to sidebar for easier access.
- updated permission modal design.
- removed to do list tool call ui from chatMessage.
- less x padding in chat input.

### Fixed

- made branch switching a lot more efficient.
- chat page is a lot snappier.
- can clear selected context with clear button.

## [0.1.77] - 2026-02-22

### Added

- Added delete confirmation modal when message is deleted from heimdall tree.

### Changed

- Updated sidebar design, rounded corners, centered buttons.
- searchbar in heimdall on open autofocuses now.

### Fixed

- Fixed z axis overlaps on chat page
- Fixed agent tool call grouping leaking (its very laggy not ready for use thus disabled by default)
- Fixed openai reasoning accumulation while streaming

## [0.1.76] - 2026-02-14

### Added

- Added a right-dock mode toggle to the HTML Tools modal so the app viewer can switch between full-screen overlay and a right-side panel.
- Added a draggable dock separator for the right-docked HTML Tools modal, including persistent live resize behavior.

### Changed

- Right-docked HTML Tools modal now uses a solid panel style (no backdrop blur), with improved separator affordance and a dedicated left grab gutter.
- Docked modal width bounds now allow shrinking down to 30% of viewport width.
- Header controls in docked mode now collapse to icon-only actions at narrow widths to prevent overflow.

### Fixed

- Fixed iframe-adjacent resize “stuck drag” behavior by introducing iframe-safe drag shields during active resize interactions.
- Applied the resize drag fix in both split panes:
- Chat view (Heimdall separator in `Chat.tsx`)
- HTML Tools docked modal separator (`HtmlToolsModal.tsx`)

## [0.1.75] - 2026-02-14

### Added

- Reworked the sidebar’s Projects view to feel like a dedicated workspace: the most-recent project expands by default, project summaries now show a “last activity” date even for local projects, and expanding a project fetches its conversations lazily.
- Added hover-only add/delete controls next to every project/conversation, letting you spin up a new chat or cleanly delete a project/conversation with cache health maintained behind the scenes (Redux + React Query updates + navigation when the active chat vanishes).
- Creating a conversation from the sidebar now immediately navigates into the new chat and refreshes the project order without waiting for the next network fetch.
- Can set default startup page to be homepage or latest chat.
- floating title bar in chat page now hides itself.
- Added a new Chat Settings toggle to group continuous reasoning/tool-call chains (`chat:groupToolReasoningRuns`), with local persistence and live sync via custom/storage events.
- Added search bar in SideBar, can search for any chat title, search is pretty lenient in pattern matching.
- logs store in app dir under /logs in ndjson file.

### Fixed

- Navigating between conversations with empty histories now clears the previous messages view so stale content is not shown.

### Changed

- Chat message rendering can now optionally collapse long contiguous reasoning + tool sequences into a single `Agent Steps (N)` collapsible section.
- The optional grouping behavior is applied consistently to both live streaming (`streamEvents`) and persisted history rendering (`contentBlocks`).
- Chat conversation title editor top bar now auto-hides while scrolling down through messages and reappears when scrolling back up, with smooth transition animations and adaptive message-list top padding.
- Sidebar now always opens on the Projects tab and the previous per-user default-tab preference in Settings has been removed, reinforcing a single consistent entry point.

## [0.1.74] - 2026-02-13

### Changed

### Fixed

- IDE file mention dropdowns from branch edits no longer render underneath adjacent virtualized message rows (stacking contexts) when extension-driven file lists are visible.
- IDE context was not clearing.
- Preserved literal replacement text in `edit_file` so escaped sequences no longer corrupt source code.

## [0.1.73] - 2026-02-13

### Added

- **OpenRouter Temperature Setting**: Provider Settings now include an `OpenRouter Temperature` field with local persistence, allowing fine-grained control over response randomness for OpenRouter models.
- **Default Bash Timeout Configuration**: Tools Configuration now includes a configurable default bash timeout setting that applies to tool runs that do not explicitly specify a `timeoutMs` value.
- **Graceful Agent Queue Handling**: Global agent queues now properly wait for the current stream to complete before processing the next request, preventing race conditions and ensuring smooth sequential execution.
- **Chat Reasoning Defaults** (Settings page): Users can now configure default thinking behavior and reasoning effort level (`low`/`medium`/`high`/`xhigh`) for supported models. These preferences persist locally and are automatically applied in Chat when the selected model supports extended thinking. Models without reasoning support will have thinking forced off regardless of the default setting.
- **GPT Account Logout**: Users can now properly log out of their GPT account, with session data and authentication tokens securely cleared.
- **Codex 5.3 Integration**: Full support for Codex 5.3 has been added, including all latest features and capabilities.
- **Notes pill and branch labeling**: Heimdall note pills now show a truncated preview of the note text, adopt a blue pill background with white text in light mode, and open a hover popup mirroring the note’s full content.
- **5.1 Codex mini**: Support added, small fast model good for small changes (write my commit browse the web etc).
- **IDE context visibility**: Added an “ide context detected” pill with a hover preview (including dark-mode styling) whenever the extension reports a selected-range; it surfaces filename/path/lines alongside the file mention dropdown.
- **Context-aware sends & branches**: Appended IDE context metadata (file path/name/line range) to every outgoing user message, including CC sends, message sends, branch submissions, and explain-from-selection flows so the model sees which file/selection the user referenced.
- **Branch coverage**: Ensured IDE-context metadata now flows through branching helpers (`sendCCBranch`, `editMessageWithBranching`, etc.) so all follow-up messages carry the inferred file context.
- **Extension 1.0.5: Folder mention support**: Added folder entries alongside files in the IDE @ picker, including explicit folder vs file metadata, directory-aware filtering, and mention insertion without fetching file contents so you can reference folder paths by name.
- **Extension 1.0.5 Port discovery resilience**: Extension now scans 3002–3015 (plus persistent host tracking) and prefers loopback, matching the Electron app’s dynamic port handling.
- **Changelog in settings**: Can read latest changelog in settings page.

### Fixed

- Bash tool workspace path validation now correctly accepts equivalent root paths (for example, trailing-slash variants) and handles `cwd` values like `.` consistently.
- Fixed the extension connecting from WSL to the app running on Windows.

## [0.1.72] - 2026-02-12

### Changed

- Global Agent has a scheduler, per second/min/day granular control for repeated prompts or tasks.
- Global Agent scheduler modal now overlays the full right sidebar so it no longer appears behind the file list.
- After sending a message, the scheduler `Enable Schedule` toggle is automatically turned off.
- Work directory for Global Agent can now be set from app settings.
- Task manager button now says “Apps” instead of “Tools”.

## [0.1.71] - 2026-02-12

### Added

- Added a structured changelog workflow for Electron desktop releases.

### Changed

- Release automation now supports publishing changelog notes with each tagged version.
