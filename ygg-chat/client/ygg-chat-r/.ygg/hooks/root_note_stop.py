import json
import sys
from urllib import request, error

MODEL = 'gpt-5.1-codex-mini'
PROVIDER = 'openai'

SYSTEM_PROMPT = '''You maintain a concise running branch note for a conversation path.

Update the note only if the latest turn materially changes it.
Keep it brief.
Preserve still-relevant context, remove stale or redundant points, and prefer 3-7 bullets.

Required output format for the note text:
[note title - short description]
- bullet 1
- bullet 2
- bullet 3

Return JSON only:
{
  "updated": true | false,
  "note": "full note text when updated, otherwise empty string",
  "reason": "short reason"
}

Set updated=false if the current note is already adequate.
Do not include markdown fences.
'''


def _json_request(url, method='GET', payload=None, timeout=20):
    data = None
    headers = {'Content-Type': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
    req = request.Request(url, data=data, headers=headers, method=method)
    with request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode('utf-8')
        return json.loads(body) if body else {}


def _safe_text(value):
    return value if isinstance(value, str) else ''


def _parse_model_json(text):
    text = (text or '').strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        start = text.find('{')
        end = text.rfind('}')
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except Exception:
                return None
    return None


def _truncate_inline(text, limit=180):
    collapsed = ' '.join(_safe_text(text).split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: max(limit - 3, 0)] + '...'


def _fallback_note(latest_user_text, latest_assistant_text):
    seed = _truncate_inline(latest_user_text) or _truncate_inline(latest_assistant_text) or 'Branch updated.'
    return '[branch note - latest turn]\n- ' + seed


def _emit_debug(message):
    print(json.dumps({'additionalContext': f'[root_note_stop] {message}'}))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print('{}')
        return

    try:
        if payload.get('hook_event_name') != 'Stop':
            print('{}')
            return

        lookup = payload.get('lookup') or {}
        local_api_base = _safe_text(lookup.get('local_api_base')).rstrip('/')
        conversation_id = _safe_text(payload.get('conversation_id'))
        lineage = payload.get('lineage') or {}
        turn = payload.get('turn') or {}

        if not local_api_base or not conversation_id:
            _emit_debug('skipped: missing local_api_base or conversation_id')
            return

        root_message_id = _safe_text(lineage.get('root_message_id'))
        current_message_id = _safe_text(payload.get('message_id'))
        current_parent_id = _safe_text(payload.get('parent_id'))
        last_user_message_id = _safe_text(turn.get('last_user_message_id'))
        last_assistant_message_id = _safe_text(turn.get('last_assistant_message_id'))
        last_assistant_text = _safe_text(payload.get('last_assistant_message'))

        messages = _json_request(f'{local_api_base}/app/conversations/{conversation_id}/messages')
        if not isinstance(messages, list) or not messages:
            _emit_debug('skipped: conversation messages unavailable')
            return

        message_by_id = {str(m.get('id')): m for m in messages if isinstance(m, dict) and m.get('id') is not None}

        def _root_from(message_id):
            current = message_by_id.get(_safe_text(message_id))
            visited = set()
            while isinstance(current, dict):
                current_id = _safe_text(current.get('id'))
                if not current_id or current_id in visited:
                    break
                visited.add(current_id)
                parent_id = current.get('parent_id')
                if parent_id is None:
                    return current
                current = message_by_id.get(str(parent_id))
            return None

        root_message = message_by_id.get(root_message_id)
        if root_message is None:
            # Prefer deriving root from the current message, then from known turn ids.
            # This is important for top-level messages where lineage.root_message_id may be missing.
            root_message = (
                _root_from(current_message_id)
                or _root_from(last_user_message_id)
                or _root_from(last_assistant_message_id)
            )

        if root_message is None and current_parent_id:
            root_message = _root_from(current_parent_id)

        if root_message is None:
            root_candidates = [m for m in messages if isinstance(m, dict) and m.get('parent_id') is None]
            root_message = root_candidates[0] if root_candidates else None

        if not root_message:
            _emit_debug(
                f'skipped: root message not found root_id={root_message_id or "<none>"} current={current_message_id or "<none>"}'
            )
            return

        root_message_id = str(root_message.get('id'))

        def _ancestor_chain_from(message_id):
            current = message_by_id.get(_safe_text(message_id))
            visited = set()
            chain = []
            while isinstance(current, dict):
                current_id = _safe_text(current.get('id'))
                if not current_id or current_id in visited:
                    break
                visited.add(current_id)
                chain.append(current)
                parent_id = current.get('parent_id')
                if parent_id is None:
                    break
                current = message_by_id.get(str(parent_id))
            return chain

        def _is_user_message(message):
            return isinstance(message, dict) and _safe_text(message.get('role')).lower() == 'user'

        def _child_count(parent_message_id):
            parent_message_id = _safe_text(parent_message_id)
            if not parent_message_id:
                return 0
            return sum(1 for item in messages if isinstance(item, dict) and _safe_text(item.get('parent_id')) == parent_message_id)

        def _branch_anchor_from(message_id):
            chain = _ancestor_chain_from(message_id)
            branching_user_candidates = []

            # Branch top for the current route = the oldest user message on this path
            # whose parent has multiple children. Walking tip->root collects all nested
            # branch entries; we want the highest/top-most one, not the nearest one.
            for candidate in chain:
                if not _is_user_message(candidate):
                    continue
                parent_id = candidate.get('parent_id')
                if parent_id is None:
                    continue
                if _child_count(parent_id) > 1:
                    branching_user_candidates.append(candidate)

            if branching_user_candidates:
                return branching_user_candidates[-1]

            # Fallback for non-branched paths: oldest user message on the current path.
            for candidate in reversed(chain):
                if _is_user_message(candidate):
                    return candidate
            return None

        path_anchor_id = last_user_message_id or current_parent_id or current_message_id or last_assistant_message_id
        note_anchor_message = _branch_anchor_from(path_anchor_id)

        if note_anchor_message is None:
            note_anchor_message = root_message if _is_user_message(root_message) else None

        if note_anchor_message is None:
            preferred_anchor_id = last_user_message_id or current_parent_id or current_message_id
            fallback_message = message_by_id.get(preferred_anchor_id) if preferred_anchor_id else None
            note_anchor_message = fallback_message if _is_user_message(fallback_message) else None

        if note_anchor_message is None:
            _emit_debug(
                f'skipped: no user note anchor found path_anchor={path_anchor_id or "<none>"} root={root_message_id or "<none>"}'
            )
            return

        note_anchor_message_id = str(note_anchor_message.get('id'))
        anchor_message_content = _safe_text(note_anchor_message.get('content'))
        existing_note = _safe_text(note_anchor_message.get('note'))

        last_user_message = message_by_id.get(last_user_message_id) if last_user_message_id else None
        last_assistant_message = message_by_id.get(last_assistant_message_id) if last_assistant_message_id else None

        latest_user_text = _safe_text((last_user_message or {}).get('content'))
        latest_assistant_text = _safe_text((last_assistant_message or {}).get('content')) or last_assistant_text

        if not latest_user_text and not latest_assistant_text:
            _emit_debug(
                f'skipped: empty latest text anchor={note_anchor_message_id} last_user={last_user_message_id or "<none>"} last_assistant={last_assistant_message_id or "<none>"}'
            )
            return

        model_input = (
            'Existing branch note:\n'
            f'{existing_note or "<empty>"}\n\n'
            'Branch anchor message:\n'
            f'{anchor_message_content or "<empty>"}\n\n'
            'Latest user message:\n'
            f'{latest_user_text or "<empty>"}\n\n'
            'Latest assistant message:\n'
            f'{latest_assistant_text or "<empty>"}\n\n'
            'Update the branch note only if needed. Keep it brief.'
        )

        generation = _json_request(
            f'{local_api_base}/headless/ygg-hooks/generate',
            method='POST',
            payload={
                'provider': PROVIDER,
                'modelName': MODEL,
                'systemPrompt': SYSTEM_PROMPT,
                'content': model_input,
            },
            timeout=45,
        )

        model_text = _safe_text(generation.get('text'))
        model_json = _parse_model_json(model_text)
        if not isinstance(model_json, dict):
            raise RuntimeError('root_note_stop: model did not return valid JSON')

        updated = bool(model_json.get('updated'))
        next_note = _safe_text(model_json.get('note')).strip()

        # Prefer model output whenever present.
        # If model asks for no update but there is no note yet, create a small fallback note
        # so new branch roots reliably get a visible pill.
        if not next_note and not existing_note:
            next_note = _fallback_note(latest_user_text, latest_assistant_text)

        if not next_note or next_note == existing_note:
            _emit_debug(
                f'skipped: anchor={note_anchor_message_id} updated={updated} has_note={bool(next_note)} unchanged={next_note == existing_note}'
            )
            return

        _json_request(
            f'{local_api_base}/app/messages/{note_anchor_message_id}',
            method='PUT',
            payload={'note': next_note},
            timeout=20,
        )

        _emit_debug(
            f'updated: anchor={note_anchor_message_id} used_fallback={not bool(_safe_text(model_json.get("note")).strip()) and not bool(existing_note)} len={len(next_note)}'
        )
    except error.HTTPError as http_error:
        raise RuntimeError(
            f'root_note_stop HTTPError: status={getattr(http_error, "code", "?")} reason={getattr(http_error, "reason", "?")}'
        ) from http_error
    except Exception as exc:
        raise RuntimeError(f'root_note_stop failed: {exc}') from exc


if __name__ == '__main__':
    main()
