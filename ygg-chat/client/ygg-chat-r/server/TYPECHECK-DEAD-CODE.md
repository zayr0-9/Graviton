# Unused declarations in the Electron/server tree

`server/tsconfig.json` sets `noUnusedLocals: false` and `noUnusedParameters: false` so that
`npm run typecheck:electron` gates on **correctness** errors only. Dead-code removal is a
separate decision from turning the compiler on, and some of these are retained on purpose
(`readCodexSseOutputLegacy_DISABLED` is named as such).

Regenerate this list at any time:

```
npx tsc -p server/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
```

## Current findings (19)

### Unused imports — safe to delete

| File | Line | Symbol |
| --- | --- | --- |
| `localServer.ts` | 17 | `BUILTIN_TOOL_DEFINITIONS` |
| `tools/htmlRenderer.ts` | 1 | `sanitizeHtmlLib` |
| `tools/viewImage.ts` | 4 | `toWslPath` (one of three named imports) |

### Unused locals / parameters — safe to delete

| File | Line | Symbol |
| --- | --- | --- |
| `localAnalyticsDashboard.ts` | 206 | `scopedConversationIdSet` |
| `localServer.ts` | 8621 | `queryEmbedding` |
| `mcp/mcpManager.ts` | 1435 | `id` (destructured loop key; use `for (const [, pending] of …)`) |
| `tools/htmlRenderer.ts` | 8 | `allowUnsafe` parameter |
| `headlessServer/routes/customToolsRoutes.ts` | 64 | `tool` parameter |

### Unused functions — need a decision

These are whole functions with no callers. Deleting them is a real change; check git history
for why they were kept before removing.

| File | Line | Symbol |
| --- | --- | --- |
| `headlessServer/providers/openaiChatgptProvider.ts` | 367 | `appendImageAttachmentsToLatestUserMessage` |
| `headlessServer/providers/openaiChatgptProvider.ts` | 607 | `transformMessagesForCodex` |
| `headlessServer/providers/openaiChatgptProvider.ts` | 678 | `mapTools` |
| `headlessServer/providers/openaiChatgptProvider.ts` | 696 | `hasImageGenerationIntent` |
| `headlessServer/providers/openaiChatgptProvider.ts` | 1437 | `readCodexSseOutput` |
| `headlessServer/providers/openaiChatgptProvider.ts` | 1501 | `readCodexWebSocketOutput` |
| `headlessServer/providers/openaiChatgptProvider.ts` | 1611 | `readCodexSseOutputLegacy_DISABLED` — named as deliberately retained |
| `localServer.ts` | 7662 | `deleteNoteEmbedding` |
| `localServer.ts` | 9406 | `normalizeContentBlocksForStorage` |
| `proxyGateway.ts` | 1364 | `mapRecordToCredentials` |

### Unused private field

| File | Line | Symbol |
| --- | --- | --- |
| `headlessServer/services/chatOrchestrator.ts` | 219 | `private readonly toolLoopService` — assigned but never read |

## Re-enabling the flags

Once the list is empty, flip `noUnusedLocals` and `noUnusedParameters` back to `true` in
`server/tsconfig.json` and delete this file.
