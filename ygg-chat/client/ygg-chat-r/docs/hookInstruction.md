============================================================================
Ygg Chat Hook Instructions
File: docs\hookInstruction.bat
Purpose:
  Documentation for the Ygg hook lifecycle, payloads, responses, and usage
  patterns when building Ygg hooks for Ygg Chat agent/tool loops.

NOTE:
  This file is intentionally a .bat file because requested, but it is being
  used primarily as documentation via comment lines.

QUICK SUMMARY
----------------------------------------------------------------------------
Ygg Chat now supports a Ygg hook lifecycle executed through the
Electron local server. Hooks are loaded from .ygg\settings.json and
.ygg\settings.local.json by walking upward from the active cwd.

Supported lifecycle events:
  - UserPromptSubmit
  - PreToolUse
  - PostToolUse
  - PostToolUseFailure
  - Stop

The renderer does NOT execute hook commands directly.
Instead, chatActions.ts calls POST /api/hooks/run on the local server, and
the Electron hook runner executes matching hook commands using the existing
bash/powershell/wsl runtime abstraction.

============================================================================
1. WHERE HOOKS ARE LOADED FROM
----------------------------------------------------------------------------
The hook runner searches for:
  - .ygg\settings.json
  - .ygg\settings.local.json

Search behavior:
  1) Start from the request cwd passed into the chat/tool loop.
  2) Walk upward through parent directories.
  3) Also search upward starting from the user home directory.

On Windows + WSL-style cwd values:
  Linux-looking paths like /home/user/project are resolved to Windows paths
  for config discovery, while command execution still uses the shell bridge.

============================================================================
2. HIGH-LEVEL EXECUTION FLOW
----------------------------------------------------------------------------
sendMessage / sendMessageToBranch / editMessageWithBranching now run:

  UserPromptSubmit
    -> before first provider request of that send/edit/branch operation

  PreToolUse
    -> before local tool execution

  PostToolUse
    -> after successful local tool execution

  PostToolUseFailure
    -> after failed local tool execution

  Stop
    -> before the agent loop fully ends when no more local tool continuation
       is pending

Hook-provided additionalContext is fed back into the next model turn by
appending a [Hook context] block onto the effective system prompt.

============================================================================
3. LOCAL API SHAPE
----------------------------------------------------------------------------
Endpoint:
  POST /api/hooks/run

Request body shape:
  {
    "event": "UserPromptSubmit" | "PreToolUse" | "PostToolUse" |
              "PostToolUseFailure" | "Stop",
    "conversationId": string | null,
    "streamId": string | null,
    "cwd": string | null,
    "provider": string | null,
    "model": string | null,
    "operation": string | null,
    "prompt": string | null,
    "toolCall": {
      "id": string | null,
      "name": string | null,
      "arguments": any
    } | null,
    "toolResult": any,
    "error": string | null,
    "lastAssistantMessage": string | null
  }

Response body shape:
  {
    "matched": boolean,
    "hookCount": number,
    "blocked"?: boolean,
    "reason"?: string,
    "updatedPrompt"?: string,
    "updatedInput"?: Record<string, unknown>,
    "permissionDecision"?: "allow" | "deny" | "ask",
    "permissionDecisionReason"?: string,
    "additionalContext"?: string,
    "errors"?: string[]
  }

Meaning of important fields:
  matched
    True if one or more hook handlers matched this event.

  hookCount
    Number of successfully executed matching handlers.

  blocked
    Used mainly by UserPromptSubmit and Stop.
    If true, the caller will block or continue depending on event semantics.

  reason
    Human-readable explanation for a blocked result.

  updatedPrompt
    Lets UserPromptSubmit rewrite the outgoing prompt before provider call.

  updatedInput
    Lets PreToolUse rewrite tool arguments before execution.

  permissionDecision
    Lets PreToolUse explicitly allow/deny/ask.
    Current integration treats deny as a hard block.

  additionalContext
    Feedback injected into the next model turn under [Hook context].

============================================================================
4. INTERNAL PAYLOAD SHAPE SENT TO HOOK COMMANDS
----------------------------------------------------------------------------
Hook commands receive JSON on STDIN.

Base payload fields sent to every hook:
  {
    "session_id": "<conversationId>:<streamId>" or "<conversationId>",
    "conversation_id": string | null,
    "cwd": string,
    "permission_mode": "default",
    "hook_event_name": "UserPromptSubmit" | "PreToolUse" |
                       "PostToolUse" | "PostToolUseFailure" | "Stop",
    "message_id": string | null,
    "parent_id": string | null,
    "lineage": {
      "root_message_id": string | null,
      "ancestor_ids": string[],
      "depth": number | null,
      "is_root": boolean
    },
    "lookup": {
      "local_api_base": string | null
    }
  }

Extra fields by event:

UserPromptSubmit:
  {
    ...base,
    "operation": "send" | "branch" | "edit-branch",
    "provider": string,
    "model": string,
    "prompt": string
  }

PreToolUse:
  {
    ...base,
    "operation": "send" | "branch" | "edit-branch",
    "provider": string,
    "model": string,
    "tool_use_id": string | null,
    "tool_name": string | null,
    "tool_input": object
  }

PostToolUse:
  {
    ...base,
    "operation": "send" | "branch" | "edit-branch",
    "provider": string,
    "model": string,
    "tool_use_id": string | null,
    "tool_name": string | null,
    "tool_input": object,
    "tool_result": any
  }

PostToolUseFailure:
  {
    ...base,
    "operation": "send" | "branch" | "edit-branch",
    "provider": string,
    "model": string,
    "tool_use_id": string | null,
    "tool_name": string | null,
    "tool_input": object,
    "error": string
  }

Stop:
  {
    ...base,
    "operation": "send" | "branch" | "edit-branch",
    "provider": string,
    "model": string,
    "last_assistant_message": string,
    "turn": {
      "last_user_message_id": string | null,
      "last_assistant_message_id": string | null
    }
  }

============================================================================
5. SETTINGS FILE FORMAT
----------------------------------------------------------------------------
Hooks are configured under the top-level "hooks" object.

Minimal example:
  {
    "hooks": {
      "UserPromptSubmit": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python .ygg/hooks/check_prompt.py"
            }
          ]
        }
      ]
    }
  }

Supported structure in current implementation:
  hooks.<Event> can be:
    - a single object
    - an array of objects

Each event entry may contain:
  {
    "matcher": string | string[],
    "hooks": [
      {
        "type": "command",
        "command": "...",
        "timeoutMs": 30000,
        "matcher": string | string[]
      }
    ]
  }

Current supported handler type:
  - command

Not currently implemented here:
  - http
  - prompt
  - agent

============================================================================
6. MATCHER RULES
----------------------------------------------------------------------------
Matchers are currently used for tool events:
  - PreToolUse
  - PostToolUse
  - PostToolUseFailure

Match target:
  tool_name

Matcher input forms supported:
  - exact name: "edit_file"
  - comma-separated: "read_file,edit_file"
  - array: ["read_file", "edit_file"]
  - wildcard-like patterns: "read_*"
  - single regex string literal form: "/^read_/"

Events like UserPromptSubmit and Stop ignore matchers in practice because
they are not tool-name based.

============================================================================
7. HOOK COMMAND OUTPUT CONTRACT
----------------------------------------------------------------------------
Hook commands can return either:
  A) JSON on stdout/stderr
  B) Plain text using simple conventions

Preferred: JSON
----------------------------------------------------------------------------
UserPromptSubmit response JSON:
  {
    "blocked": true,
    "reason": "Prompt contains forbidden deployment target"
  }

  {
    "updatedPrompt": "Rewritten prompt text",
    "additionalContext": "Remember to follow repository conventions."
  }

PreToolUse response JSON:
  {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Do not edit files outside src/."
  }

  {
    "permissionDecision": "allow",
    "updatedInput": {
      "path": "src/safe-target.ts",
      "operation": "replace_first"
    },
    "additionalContext": "Tool target normalized to approved file."
  }

PostToolUse / PostToolUseFailure response JSON:
  {
    "additionalContext": "Summarize the file changes before continuing."
  }

Stop response JSON:
  {
    "blocked": true,
    "reason": "Run verification and summarize results before stopping."
  }

Plain text fallback
----------------------------------------------------------------------------
The parser also understands simple text output:

  blocked: reason here
  deny: reason here
  allow
  ok

For non-blocking non-JSON text, the entire text is treated as
additionalContext.

============================================================================
8. EVENT SEMANTICS INSIDE YGG CHAT
----------------------------------------------------------------------------
UserPromptSubmit:
  - Runs once before the first provider request for the send/edit/branch op.
  - Can block the request.
  - Can rewrite the outgoing prompt.
  - Can append additionalContext for the next turn.

PreToolUse:
  - Runs before executeLocalTool.
  - Can deny tool execution.
  - Can rewrite tool arguments.
  - Can append additionalContext for next turn.

PostToolUse:
  - Runs after successful tool execution.
  - Best used for observations, reminders, follow-up guidance.

PostToolUseFailure:
  - Runs after tool execution failure.
  - Best used for repair guidance or recovery strategies.

Stop:
  - Runs when the loop would otherwise finish.
  - If blocked=true, Ygg continues the loop by injecting hook context into the
    next turn and asking the model to keep going.

============================================================================
9. HOW HOOK CONTEXT FLOWS BACK TO THE MODEL
----------------------------------------------------------------------------
additionalContext is stored in a pending array and then injected into the next
provider call like this conceptually:

  [existing system prompt]

  [Hook context]
  your hook-generated instruction here

Multiple hook contexts are joined together with blank lines.

This means hook authors can safely steer the next turn without pretending to
be the user.

============================================================================
10. BEST PRACTICES FOR AGENTS BUILDING HOOKS
----------------------------------------------------------------------------
A. Prefer JSON output.
   It is the most stable and expressive integration format.

B. Be event-specific.
   UserPromptSubmit should focus on prompt validation/rewriting.
   PreToolUse should focus on permissioning and argument normalization.
   Stop should focus on completion gating.

C. Keep additionalContext concise and actionable.
   Good:
     "Before answering, verify whether tests were changed."
   Less good:
     30 paragraphs of repeated instructions.

D. Use matchers aggressively for tool hooks.
   Example: restrict only edit_file and bash without affecting read_file.

E. Prefer deny with explicit reason for unsafe actions.
   This produces more useful recovery behavior than generic failures.

F. Rewrite inputs only when deterministic.
   Hooks should not silently redirect work in surprising ways unless you are
   very sure that is what the repo wants.

G. Treat Stop as a quality gate.
   Use it to enforce:
     - verification
     - summary requirements
     - test reminders
     - repository-specific completion policy

============================================================================
11. EXAMPLE SETTINGS
----------------------------------------------------------------------------
Example 1: Block dangerous bash commands
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": ["bash"],
          "hooks": [
            {
              "type": "command",
              "command": "python .ygg/hooks/check_bash.py"
            }
          ]
        }
      ]
    }
  }

Example 2: Force final verification before stop
  {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python .ygg/hooks/require_verification.py"
            }
          ]
        }
      ]
    }
  }

Example 3: Rewrite edit_file target paths
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": ["edit_file"],
          "hooks": [
            {
              "type": "command",
              "command": "python .ygg/hooks/normalize_edit_target.py"
            }
          ]
        }
      ]
    }
  }

============================================================================
12. EXAMPLE PYTHON HOOKS
----------------------------------------------------------------------------
Example UserPromptSubmit hook:
  import json, sys
  payload = json.load(sys.stdin)
  prompt = payload.get("prompt", "")
  if "prod database" in prompt.lower():
      print(json.dumps({
          "blocked": True,
          "reason": "Direct production database operations are blocked."
      }))
  else:
      print(json.dumps({
          "additionalContext": "Follow project coding conventions."
      }))

Example PreToolUse hook:
  import json, sys
  payload = json.load(sys.stdin)
  tool = payload.get("tool_name")
  tool_input = payload.get("tool_input") or {}
  if tool == "edit_file":
      path = str(tool_input.get("path", ""))
      if not path.startswith("src/"):
          print(json.dumps({
              "permissionDecision": "deny",
              "permissionDecisionReason": "Only src/ edits are allowed."
          }))
      else:
          print(json.dumps({"permissionDecision": "allow"}))
  else:
      print("allow")

Example Stop hook:
  import json, sys
  payload = json.load(sys.stdin)
  last = payload.get("last_assistant_message", "")
  if "tests not run" in last.lower():
      print(json.dumps({
          "blocked": True,
          "reason": "Run or discuss tests before stopping."
      }))
  else:
      print("ok")

============================================================================
13. OPERATION VALUES YOU CAN EXPECT
----------------------------------------------------------------------------
Current operation strings sent from chatActions:
  - send
  - branch
  - edit-branch

These map to the originating chat flow:
  send         = standard message send
  branch       = send new branch from selected parent
  edit-branch  = edit an earlier message and continue on a new branch

============================================================================
14. LIMITATIONS / CURRENT IMPLEMENTATION NOTES
----------------------------------------------------------------------------
- Only command hooks are implemented right now.
- Hook commands receive payload via STDIN JSON.
- Hook runner merges multiple matching handlers in order.
- Errors from one hook do not stop evaluation of later hooks; they are added
  to the returned errors array.
- PreToolUse permissionDecision=ask is parsed, but current integration mainly
  uses deny vs continue. If you need richer ask behavior, extend chatActions.
- PostToolUse/PostToolUseFailure are feedback-oriented; they do not undo tools.

============================================================================
15. RECOMMENDED FUTURE EXTENSIONS
----------------------------------------------------------------------------
If you extend this system later, likely next steps are:
  - http hook support
  - richer matcher semantics
  - global/home-scoped settings precedence docs
  - ask-mode integration for pre-tool hooks
  - structured observability / hook event logs
  - per-provider / per-model conditional policies

============================================================================
16. TROUBLESHOOTING
----------------------------------------------------------------------------
Symptom: hook not running
  Check:
    - cwd is what you expect
    - .ygg/settings.json exists in cwd or parent chain
    - event name is correct
    - matcher actually matches tool_name
    - command is executable from resolved shell

Symptom: weird output parsing
  Prefer explicit JSON output instead of plain text.

Symptom: path issues on Windows
  The shell runner may use PowerShell or WSL depending on cwd path format.
  Keep your hook command paths compatible with the chosen environment.

Symptom: hook errors but flow continues
  This is expected in current implementation: errors are collected rather than
  immediately aborting the whole hook pipeline.

============================================================================
END
============================================================================

## Hook text generation provider

In the chat Settings pane, expand Hooks and choose **Auto**, **OpenAI / ChatGPT**, or **Claude Code**, then save. This host-wide choice is separate from the conversation provider. Each backend retains its own model: OpenAI defaults to `gpt-6-luna`; an empty Claude model uses the CLI default (aliases such as `haiku` or `sonnet` may also be entered).

Auto uses the host's configured OpenAI connection; when signed out or reconnect is required before generation, it chooses Claude instead. Explicit choices never switch providers. Rate limits, timeouts, unavailable models and other generation failures do not retry with a different provider. Claude needs an installed, signed-in Claude Code CLI; its own account/environment determines billing. No OpenAI subscription is needed to select Claude.

Hooks using `POST /api/headless/ygg-hooks/generate` send `content` and optional `systemPrompt`; saved host settings override legacy provider/model hints. The result includes `text`, `provider` and `modelName`. Existing installed note scripts keep working without overwriting their customizations. The isolated Claude print process exposes no tools or MCP servers and does not persist or resume the chat session. At most two generations run concurrently; the server deadline is 40 seconds, below the note script's 45-second HTTP timeout. The script still only writes notes on branched paths.
