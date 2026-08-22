ygg-headless server

Goal

Decouple frontend chat orchestration from inference so Electron can run as a standalone headless backend for any UI.

Existing state

Main orchestration still lives in frontend thunks (chatActions.ts): send/repeat/branch/edit branch loops, tool execution continuation, provider routing.

OpenAI ChatGPT streaming client logic is in frontend (OpenAIChatGPT.ts) and token storage/refresh is in frontend localStorage (openaiOAuth.ts).

Local server has many CRUD routes, but no full parity chat SSE endpoints (/conversations/:id/messages, /messages/repeat, /generate/ephemeral).

electron/localServer.ts contains duplicated /api/app/\* blocks; later block has mismatched SQL argument orders and stale statement names.

Thunks/features to migrate (with approx lines)

compactBranch (~1955)

sendMessage (~2207)

editMessageWithBranching (~3957)

sendMessageToBranch (~5225)

Helpers used by above:

executeToolWithPermissionCheck (~1822)

openConversationStreamWithRetry (~1880)

persistAssistantMessageWithFallback (~1902)

createToolResultMessage (~102)

buildToolNameMap (~680)

sanitizeToolResultContentForModel (~697)

sanitizeContentBlocksForModel (~706)

persistToolResultsWithFallback (toolResultPersistence.ts ~114)

openStreamingWithPreFirstByteRetry (streamResilience.ts ~131)

Provider/inference modules:

createOpenAIChatGPTStreamingRequest (OpenAIChatGPT.ts ~758)

token persistence/refresh (openaiOAuth.ts: refresh ~366, token key ~438, getValidTokens ~462)

Migration target structure

electron/headlessServer/

index.ts (bootstrap + registration)

routes/chatRoutes.ts (SSE message/repeat/branch/edit endpoints)

routes/crudRoutes.ts (conversation/message/project ops for third-party clients)

routes/providerAuthRoutes.ts (OpenAI oauth start/complete/refresh + model listing)

services/chatOrchestrator.ts (multi-turn tool loop state machine)

services/branchOrchestrator.ts (edit/branch semantics)

services/compactionService.ts

services/toolLoopService.ts

services/providerRouter.ts (OpenRouter/ChatGPT/LM Studio dispatch)

providers/openaiChatgptProvider.ts

providers/openRouterProvider.ts

providers/lmStudioProvider.ts

providers/tokenStore.ts (DB-backed provider tokens)

persistence/messageRepo.ts, conversationRepo.ts, projectRepo.ts

stream/sseWriter.ts, stream/eventTypes.ts

../../../../shared/headlessApi.ts (request/response + SSE event schema; shared with the renderer)

Non-trivial fixes in current localServer.ts to do immediately

Remove duplicate /api/app/\* blocks (first around ~4173, second around ~6910).

Fix broken arg order/count for upsertConversation.run in app routes (~4241, ~6983) to match statement signature (~1013).

Remove stale statement usage (getLocalConversationsByProject ~7020, getLocalMessagesByConversation ~7141).

Remove stale owner_id SQL usage in app conversations query (~7026); use user_id.

Execution approach

Phase 0 (stabilize): clean duplicated app routes + add API parity tests around message tree invariants.

Phase 1 (extract): move existing route logic from localServer.ts into headlessServer/routes/\* without behavior changes.

Phase 2 (orchestrator): implement server-side chat orchestration service equivalent to send/edit/branch thunks; add SSE endpoints.

Phase 3 (providers): move OpenAI ChatGPT and OpenRouter provider calls to server modules; store tokens server-side.

Phase 4 (tool loop): centralize full tool call orchestration (pending->execute->tool_result->continue) server-side.

Phase 5 (frontend thinning): replace heavy thunks with thin SSE clients; remove local inference code paths.

Phase 6 (externalization): publish stable api/v1 contract for third-party UIs + capability endpoint.
