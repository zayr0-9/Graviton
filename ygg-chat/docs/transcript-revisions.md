# Revising an earlier answer

After the current reply finishes, send `/revise` followed by your request in the branch you want to change. For example:

> `/revise In your first answer, change the Docker command to use port 8080.`

Graviton shows what will be removed and added. Choose **Apply revision** or **Decline**. This confirmation is required even under **Allow all**. The same reply shows the revision; **Edited · Show original** toggles the original display, and **Undo revision** restores the preceding version on that branch. The assistant should acknowledge the change briefly rather than reposting the answer.

This is a display revision. Later replies, tool and reasoning records, sibling branches, and the provider's replay history (including Claude Code's native session and compaction summaries) are not rewritten. A follow-up correction that should affect reasoning belongs in a new user message. The original is also still available to tools that read canonical history, search, and tree views; this is not a redaction feature.

## Implementation boundaries

- Only an ordinary, fresh user submission beginning `/revise` enables the tool. Queueing the command is refused. Hooks cannot grant eligibility, and background, repeated, child, and nested calls cannot independently create a revision turn.
- The host binds `list`, `read`, and `propose` to the resolved lineage and the reply ancestry that existed before the user request. Shared ancestors qualify; sibling messages, current-run output, errors and synthetic rows do not. The tool can discover replies from before compaction even though the provider no longer receives those rows in ordinary replay.
- Proposals replace unique, exact text in identified display blocks. The host previews them before writing and revalidates the target and latest saved revision transactionally after approval. The original message, ID and all non-text content stay unchanged.
- The primary and parallel transcript views fetch the display revisions by lineage. The host change feed invalidates the affected view on apply or undo. Claude Code advertises the tool only in a revision turn; crossing that boundary may relaunch a warm CLI with the same native history.
