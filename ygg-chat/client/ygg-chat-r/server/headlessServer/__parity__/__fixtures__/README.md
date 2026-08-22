# Chat-loop parity fixtures

Recorded SSE streams used by `../chatLoop.parity.test.ts` to dual-run the server
engine against the current renderer path deterministically (Railway/provider
responses are non-deterministic, so we record once and replay).

## Format

One JSON file per `<provider>.<operation>.json`, e.g. `openrouter.send.json`:

```jsonc
{
  "request": {                 // the HeadlessMessageRequest inputs
    "provider": "openrouter",
    "operation": "send",
    "modelName": "…",
    "content": "…",
    "conversationId": "…",
    "parentId": null,
    "tools": []
  },
  "providerEvents": [          // raw provider/Railway SSE frames, in arrival order
    { "type": "chunk", "part": "text", "delta": "Hello" },
    { "type": "tool_call", "toolCall": { "id": "t1", "name": "read_file", "arguments": "{…}" } },
    { "type": "free_generations_update", "remaining": 41, "isFreeTier": true },
    { "type": "complete", "message": { /* … */ } }
  ],
  "golden": {                  // expected, captured from the current renderer path
    "sseEvents": [ /* ordered HeadlessStreamEvent types the server should emit */ ],
    "messageTree": [ /* persisted rows: id, parent_id, role, content_blocks, tool_calls */ ]
  }
}
```

## Capture

A capture harness (Phase 1) records `providerEvents` from a live run and the
`golden` output from the current renderer thunks, so fixtures stay faithful.
Until then, `chatLoop.parity.test.ts` holds `it.todo` placeholders.
