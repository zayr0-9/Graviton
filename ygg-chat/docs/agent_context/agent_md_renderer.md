# Agent Context: Markdown and Text Response Rendering

Last reviewed: 2026-08-02

## Purpose

Documents how model responses are rendered as Markdown/text in the main chat UI. The route-level orchestration lives in `client/ygg-chat-r/src/containers/Chat.tsx`, while actual Markdown parsing and per-message rendering lives mostly in `client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx` and shared styling in `client/ygg-chat-r/src/index.css`.

Open this when changing:
- how assistant/user text, streamed deltas, `content_blocks`, tool calls, reasoning, or images become visible in Chat;
- Markdown plugins, syntax highlighting, math rendering, links, code blocks, copy buttons, or prose classes;
- process/tool/reasoning grouping in `Chat.tsx` or `ChatMessage.tsx`;
- CSS that affects `.prose`, inline code, fenced code blocks, highlight.js, KaTeX, or chat message typography.

## Key Files

- `client/ygg-chat-r/src/containers/Chat.tsx`: parses message payloads, decides virtual rows, passes render props into `ChatMessage`.
- `client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx`: renders one message, including Markdown, content blocks, stream events, reasoning, tool cards, images, edit/branch UI, and selection actions.
- `client/ygg-chat-r/src/components/ChatMessage/chatMessageShared.ts`: shared Markdown/prose classes, content-block edit conversion, tool-group builders, response-item extraction helpers.
- `client/ygg-chat-r/src/features/chats/chatTypes.ts`: `ContentBlock`, `StreamEvent`, `ToolCall`, and stream state types.
- `client/ygg-chat-r/src/index.css`: global Tailwind/prose/Highlight.js/KaTeX styling and animation utilities used by rendered messages.
- `client/ygg-chat-r/src/components/MarkdownLink/MarkdownLink.tsx`: custom anchor renderer used by chat Markdown.

## End-to-End Rendering Flow

### 1. Model/runtime output is normalized into message fields

The UI can render model output from several shapes:

- legacy `message.content` plain Markdown string;
- `message.thinking_block` legacy reasoning string;
- `message.tool_calls` legacy structured tool call array/object/string;
- `message.content_blocks` ordered structured blocks;
- live `streamState.buffer`, `streamState.thinkingBuffer`, `streamState.toolCalls`, and `streamState.events` while a stream is active.

`ContentBlock` currently includes:
- `text`: Markdown text in `content`;
- `thinking`: reasoning/thinking text in `content`;
- `tool_use`: tool name and input;
- `tool_result`: tool output linked by `tool_use_id`;
- `image`: generated image URL;
- `reasoning_details`: provider-specific reasoning metadata.

Some providers also store an internal block with `type: 'responses_output_items'`. It is not in the exported `ContentBlock` union, but `Chat.tsx` and `ChatMessage.tsx` handle it by treating assistant message items as text and reasoning items as process content.

### 2. `Chat.tsx` parses and orders payloads before rendering

`parseMessageDataForRender(msg)` in `Chat.tsx` is the first UI normalization layer:

- parses `tool_calls` if it is JSON text, an object, or an array;
- parses `content_blocks` if it is JSON text, an object, or an array;
- ensures parsed content blocks have numeric `index` values and are sorted by `index` when needed;
- keeps invalid block payloads from crashing the UI by warning and falling back to `undefined`;
- logs diagnostics for legacy `thinking_block` when no reasoning exists in `content_blocks`.

The parsed result is cached by a signature containing message ID, role, update/create timestamp, artifact count, `content`, `content_blocks`, `tool_calls`, `thinking_block`, and notes. If these inputs do not change, the same parsed map is reused to reduce render churn.

### 3. `Chat.tsx` chooses virtual rows

`Chat.tsx` renders the message list with TanStack Virtual. The row derivation pipeline is:

1. `displayMessages` from selectors is filtered into `renderableMessages`.
2. `parsedMessageDataById` is built with `parseMessageDataForRender`.
3. `messageRenderRows` is derived from renderable messages.
4. `virtualRows` adds optimistic messages, branch optimistic messages, live streaming rows, and generation loaders.

For each normal message row, `Chat.tsx` passes these props to `ChatMessage`:

- `content={msg.content}` for legacy Markdown fallback;
- `thinking={displayThinking}` for legacy reasoning fallback;
- `toolCalls={displayToolCalls}` for legacy tool fallback;
- `contentBlocks={displayContentBlocks}` for ordered structured rendering;
- `streamEvents={streamState.events}` only for live streaming messages;
- message metadata, artifacts, font offset, theme, actions, undo state, and grouping settings.

### 4. `ChatMessage.tsx` performs actual rendering

`ChatMessage` prioritizes render sources in this order:

1. `streamEvents` when present and not editing;
2. `contentBlocks` when present and not editing;
3. legacy fields: `toolCalls`, `thinking`, then `content`.

This priority is important: if `contentBlocks` or `streamEvents` exist, legacy `content` is not rendered again, preventing duplicated text.

## Markdown Rendering Implementation

`ChatMessage.tsx` defines `renderMarkdownNode`, which wraps `ReactMarkdown` in a styled `<div>`.

Plugins:
- `remark-gfm` for GitHub-flavored Markdown such as tables/task-list syntax/autolinks;
- `remark-math` for Markdown math parsing;
- `rehype-highlight` with `{ ignoreMissing: true }` for fenced code highlighting;
- `rehype-katex` for math rendering.

Custom component renderers:
- `pre: PreRenderer` wraps fenced code blocks in a bordered `not-prose` container and adds a copy button;
- `code: CodeRenderer` applies custom inline-code colors and leaves block code to Highlight.js/pre styling;
- `a: MarkdownLink` renders links through the app's link component.

`renderMarkdownNode` receives a class name from `chatMessageShared.ts`:
- `SHARED_TEXT_MARKDOWN_CLASS`: current structured/streamed text block rendering;
- `LEGACY_TEXT_MARKDOWN_CLASS`: legacy full-message `content` fallback;
- `REASONING_TEXT_MARKDOWN_CLASS`: expanded reasoning/thinking content.

These classes all use Tailwind Typography `.prose`, `dark:prose-invert`, responsive text sizing, and tighter paragraph/list/heading/pre spacing.

## Stream Event Rendering

For live streams, `Chat.tsx` supplies `streamEvents`, `buffer`, `thinkingBuffer`, and `toolCalls` from the branch-aware current stream.

`ChatMessage` uses stream events to preserve model output order:
- adjacent text deltas are accumulated into a single Markdown render item;
- reasoning deltas become collapsible reasoning items unless hidden by streaming rules;
- tool call and tool result events are grouped with `buildToolCallGroupsFromStream`;
- image events render image nodes.

If final text is streaming, `Chat.tsx` may render a live streaming tail outside the virtualized list to avoid TanStack Virtual scroll compensation while long text grows. The same `ChatMessage` Markdown renderer is still used for the visible final text.

## Content Block Rendering

For persisted structured messages, `ChatMessage` uses `buildContentBlockRenderItems()`:

- `text` blocks render through `renderMarkdownNode` with `SHARED_TEXT_MARKDOWN_CLASS`.
- `thinking` blocks are accumulated with adjacent thinking blocks and rendered as collapsible reasoning using `REASONING_TEXT_MARKDOWN_CLASS`.
- `reasoning_details` blocks are skipped directly; they mainly support reasoning de-duplication/provider metadata.
- `tool_use` and matching `tool_result` blocks are grouped with `buildToolCallGroupsFromBlocks` and rendered as tool cards.
- `image` blocks render as clickable images using `MESSAGE_IMAGE_CLASS`.
- `responses_output_items` blocks are rendered only when there are no explicit normal renderable blocks; assistant message items become Markdown text and reasoning items become reasoning cards.

A content block with short connective text can be marked `ignoreForProcessRunGrouping` so it does not break a larger process/tool/reasoning run.

## Legacy Field Rendering

If neither `streamEvents` nor `contentBlocks` are present:

- `toolCalls` render first as tool cards;
- `thinking` renders as a collapsible reasoning block;
- `content` renders as Markdown using `LEGACY_TEXT_MARKDOWN_CLASS`.

This keeps older messages displayable while the preferred modern path remains ordered `content_blocks` or `streamEvents`.

## Generic Tool-Output Truncation

Generic tool results are a renderer-only projection controlled by `chat:truncateToolOutput`:

- The preference defaults to enabled and is persisted in `localStorage`.
- `SettingsPane.tsx` saves the preference and dispatches `chat:truncateToolOutputChange`; `Chat.tsx` also listens for cross-window `storage` changes and passes `truncateToolOutput` to every `ChatMessage`.
- When enabled, a generic result longer than 2,000 Unicode characters renders as a raw preview containing approximately 1,000 characters from the beginning and end plus an omitted-character marker.
- The 2,000-character budget applies to the serialized whole result, so oversized objects and `multi_call` payloads do not construct an unbounded structured result tree.
- Tool inputs/arguments and specialized HTML, MCP app, edit diff, plan display, and internal-link renderers are not truncated.
- Canonical Redux state, SSE payloads, persisted messages, hooks, and model-facing tool results remain complete. Disabling the global preference restores complete generic output.

Collapsed generic tool cards do not construct their result subtree until expanded. Preserve this behavior when changing tool-card rendering so truncation continues to reduce DOM work rather than only hiding full content with CSS.

## Process/Tool/Reasoning Grouping

There are two related grouping layers.

### Cross-message grouping in `Chat.tsx`

When `chat:groupToolReasoningRuns` is enabled, `Chat.tsx` can collapse consecutive process-only assistant/ex-agent messages into a single `process_group` row if the run has at least `CROSS_MESSAGE_PROCESS_GROUP_MIN_MESSAGES` messages.

A message is process-only when it has reasoning/tool/process signals but no substantial text or image content. `Chat.tsx` identifies process signals from:
- `thinking_block`;
- parsed `tool_calls`;
- `content_blocks` of type `thinking`, `tool_use`, `tool_result`, `reasoning_details`;
- reasoning inside `responses_output_items`.

If a following assistant message contains both process content and substantial final text, `Chat.tsx` may bridge its process blocks into the group and pass only non-process content to that final message row. This avoids showing the same tool/reasoning content twice.

### Within-message grouping in `ChatMessage.tsx`

`ChatMessage` can group long runs of process items within a single message or stream. Process items include reasoning and tool cards. Text that looks like a short process annotation is allowed not to break the group.

The relevant CSS utilities are `tool-expand-container`, `tool-expand-content`, and `tool-chevron` in `index.css`.

## Editing and Branching Text

When a message enters edit or branch mode, `ChatMessage` does not show Markdown. It shows a `TextArea`.

For messages with `contentBlocks`, `contentBlocksToEditableText()` converts blocks into editable text:
- text blocks become raw text;
- thinking blocks become `[THINKING]...[/THINKING]`;
- tool uses/results become bracketed pseudo-blocks.

On save/branch, `editableTextToContentBlocks()` reconstructs content blocks when the original message had blocks. This parser is intentionally conservative and treats malformed pseudo-blocks as plain text where possible.

## Styling in `index.css`

`index.css` imports the global dependencies needed by Markdown rendering:

- Tailwind and `@tailwindcss/typography` for `.prose`;
- `katex/dist/katex.min.css` for math output;
- `highlight.js/styles/atom-one-light.css` for base light syntax highlighting.

Important Markdown CSS behavior:
- `.prose pre:not(.not-prose)` styles normal Typography-generated code blocks;
- `.prose :not(pre) > code` styles inline code and uses `box-decoration-break: clone` for wrapped inline code;
- `.prose :not(pre) code` forces inline layout as a safety net for nested inline code;
- `.prose pre code.hljs` removes highlight.js background/padding so the surrounding `<pre>` controls visuals;
- `.prose pre code::before/::after` and inline-code pseudo-elements are disabled so Typography does not inject backticks;
- `.prose pre, .prose pre code, .prose pre code *` remain selectable;
- `.dark .hljs-*` overrides syntax colors for manual `.dark` class dark mode.

Note: `ChatMessage` uses a custom `PreRenderer` with `not-prose`, so the global `.prose pre:not(.not-prose)` styling is mainly a fallback and is also used by other Markdown surfaces. The global highlight.js token colors still affect highlighted code spans inside custom pre blocks.

## Theming and Font Size

`Chat.tsx` passes `customTheme`, `customThemeEnabled`, `isDarkMode`, and `fontSizeOffset` to every `ChatMessage`.

`ChatMessage` resolves custom colors for:
- code block background, border, and text;
- inline code background and text;
- role/message surfaces through the role theme system.

The `fontSizeOffset` is applied through inline `style` on Markdown containers or process labels as `calc(... + Npx)`. Chat listens to `fontSizeOffsetChange` and `storage` events for `chat:fontSizeOffset`.

## Invariants

- Prefer `content_blocks`/`streamEvents` for new provider output because they preserve ordering between text, reasoning, tools, and images.
- Keep `content_blocks` sorted by `index` before rendering.
- Do not render legacy `content` when `contentBlocks` or `streamEvents` are present, or text will duplicate.
- Do not bypass `renderMarkdownNode` for model text unless a surface intentionally needs plain text.
- Keep fenced code blocks selectable and copyable.
- Keep `rehypeHighlight` configured with `ignoreMissing: true` so unknown code fence languages do not break rendering.
- Keep generated HTML/tool iframe rendering separate from Markdown. Tool HTML is registered/opened through the HTML iframe registry, not injected into ReactMarkdown.
- Keep generic tool-output truncation renderer-only; never truncate canonical persisted, streamed, hook, or model-facing tool results.
- Avoid adding untrusted raw HTML support to ReactMarkdown unless a separate sanitizer and threat model are introduced.
- Preserve stable virtual row keys and measured containers when changing message render output.

## Common Change Recipes

### Add support for a new content block type

1. Add or extend the type in `chatTypes.ts` if it is part of the app contract.
2. Ensure providers/stream reducers produce `index` values.
3. Update `parseMessageDataForRender` in `Chat.tsx` only if the block affects process grouping or substantial-content detection.
4. Update `buildContentBlockRenderItems()` in `ChatMessage.tsx` to render it.
5. Update edit conversion in `chatMessageShared.ts` if users should edit/branch it.
6. Validate persisted and streaming versions if both exist.

### Change Markdown styling

1. Prefer changing shared classes in `chatMessageShared.ts` for chat-only spacing/typography.
2. Use `index.css` for global `.prose`, Highlight.js, KaTeX, and animation utilities.
3. Check both light and dark mode.
4. Check inline code, fenced code, nested inline code, lists, tables, math, and long code lines.

### Change code block rendering

1. Start in `PreRenderer`/`CodeRenderer` in `ChatMessage.tsx` for chat messages.
2. Keep `not-prose` on custom pre wrappers to avoid Typography fighting the custom layout.
3. Preserve copy behavior and text selection.
4. Confirm global `index.css` still handles other Markdown surfaces such as Settings/Heimdall/plan views.

### Change process grouping

1. Update `isProcessContentBlock`, `hasSubstantialTextOrImage`, and count helpers in `Chat.tsx` for cross-message grouping.
2. Update `buildStreamRenderItems()` / `buildContentBlockRenderItems()` and `renderItemsWithOptionalProcessGrouping()` in `ChatMessage.tsx` for within-message grouping.
3. Validate with `chat:groupToolReasoningRuns` both enabled and disabled.

## Validation

Recommended checks after renderer changes:

- Build: `npm --prefix client/ygg-chat-r run build:electron`.
- Manual message samples:
  - plain Markdown paragraphs/headings/lists/tables/task lists;
  - inline code and fenced code with known/unknown language names;
  - math inline/block rendering;
  - streaming final text with reasoning/tool events interleaved;
  - persisted `content_blocks` with text, thinking, tool use/result, and image blocks;
  - legacy messages with only `content`, `thinking_block`, and `tool_calls`;
  - dark mode and custom theme code colors;
  - edit and branch a message originally backed by `content_blocks`.

## Related Docs

- `agent_chat_container.md`
- `agent_chat_streaming_state.md`
- `agent_chat_pipeline.md`
- `agent_heimdall.md`
