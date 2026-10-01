import { CONTEXT_INJECTION_KIND } from '../../../shared/contextInjection.js'

/**
 * Human top-level prompts for sidebar previews and chat-history summaries.
 * Generated launch-context user rows are transparent only at the root boundary:
 * walk their children, but stop at ordinary messages so later turns stay excluded.
 * Keep the compact response shape and original IDs; never change the stored tree.
 */
export const TOP_LEVEL_USER_MESSAGES_SQL = `
  WITH RECURSIVE
  scoped_messages AS (
    SELECT id, parent_id, role,
      CASE WHEN role = 'user' AND json_valid(meta)
        THEN COALESCE(json_extract(meta, '$.kind') = '${CONTEXT_INJECTION_KIND}', 0)
        ELSE 0
      END AS is_context_injection
    FROM messages
    WHERE conversation_id = ?
  ),
  preview_candidates AS (
    SELECT * FROM scoped_messages WHERE parent_id IS NULL
    UNION
    SELECT child.*
    FROM scoped_messages child
    JOIN preview_candidates parent ON child.parent_id = parent.id
    WHERE parent.is_context_injection = 1
  )
  SELECT m.id, m.conversation_id, m.content, m.plain_text_content, m.note, m.note_color, m.created_at
  FROM messages m
  JOIN preview_candidates candidate ON candidate.id = m.id
  WHERE candidate.role = 'user' AND candidate.is_context_injection = 0
  ORDER BY m.created_at ASC
`
