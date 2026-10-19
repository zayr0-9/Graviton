import json
import re
import sys
import time
import traceback
from urllib import request, error, parse

MODEL = 'gpt-6-luna'
PROVIDER = 'openai'

# Semantic note-pill color scheme. Each color maps to one category; the
# note model assigns it strictly from the nature of the summary. This is a
# Cartesian 5-color palette, intentionally small — enough to fill categories.
NOTE_COLOR_PRESETS = [
    '#22c55e',  # green  - question / clarification / help
    '#ef4444',  # red    - bug / error / fix
    '#8b5cf6',  # purple - new feature / enhancement
    '#3b82f6',  # blue   - refactor / improvement / performance
    '#f59e0b',  # amber  - general / documentation / misc
]

SYSTEM_PROMPT = '''You maintain a concise running branch note for a conversation path.

Update the note only if the latest turn materially changes it.
Keep it brief.
Preserve still-relevant context, remove stale or redundant points, and prefer 3-7 bullets.

Required output format for the note text:
## note title - short description
- bullet 1
- bullet 2
- bullet 3

Set note_color ONLY when creating a note for the first time (when the
"Existing branch note" input is <empty>). Never change a color while updating
or appending to an existing note: return note_color as an empty string in that
case, because its originally assigned color must remain unchanged.

For a first-time note only, classify the note's dominant purpose using this
exact scheme; each category maps to one color:

- Questions / clarifications / help requested  -> #22c55e (green)
- Bug reports / errors / fixes                -> #ef4444 (red)
- New features / enhancements / additions     -> #8b5cf6 (purple)
- Refactors / improvements / performance      -> #3b82f6 (blue)
- General / docs / other                      -> #f59e0b (amber)

Rules:
- For a first-time note, pick exactly ONE color that best fits its dominant purpose.
- When a new note mixes categories, choose the color of the most significant purpose.
- Do not invent colors. Only the five hex values above are allowed.
- For an existing note, note_color MUST be an empty string.

Return JSON only:
{
  "updated": true | false,
  "note": "full note text when updated, otherwise empty string",
  "note_color": "a scheme hex only for a first-time note; otherwise empty string",
  "reason": "short reason"
}

Set updated=false if the current note is already adequate.
For a first-time note, note_color must be exactly one of the five allowed hex values.
Do not include markdown fences.
'''


class HookFailure(RuntimeError):
    def __init__(self, code, stage, message, **details):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.details = details


def _safe_error_detail(value, sensitive=()):
    """Bound error messages, never log response bodies or request contents."""
    text = value if isinstance(value, str) else ''
    for private_text in sorted(set(sensitive), key=len, reverse=True):
        if private_text:
            text = text.replace(private_text, '[content omitted]')
    text = re.sub(r'(?i)\bBearer\s+[^\s,;"\']+', 'Bearer [redacted]', text)
    text = re.sub(
        r'''(?ix)(["']?(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)''',
        r'\1[redacted]', text,
    )
    text = re.sub(r'https?://[^\s<>"\']+', '[url omitted]', text)
    text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[redacted]', text)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]+\b', '[redacted]', text)
    return ' '.join(text.split())[:400]


def _http_error_detail(http_error, sensitive):
    # Only extract known error fields from bounded JSON; HTML and arbitrary bodies
    # can contain private content and are deliberately excluded.
    try:
        with http_error:
            body = http_error.read(4097)
        if len(body) > 4096:
            return None
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            return None
        detail = parsed.get('error') or parsed.get('message')
        if isinstance(detail, dict):
            detail = detail.get('message')
        return _safe_error_detail(detail, sensitive) or None
    except Exception:
        return None


def _json_request(url, method='GET', payload=None, timeout=20, stage='callback', sensitive=()):
    data = None
    headers = {'Content-Type': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
    req = request.Request(url, data=data, headers=headers, method=method)
    started = time.monotonic()
    # No origin, credentials, query string, or fragment in diagnostics.
    details = {'method': method, 'path': parse.urlsplit(url).path, 'timeoutSeconds': timeout}

    def failure(code, message):
        return HookFailure(code, stage, message, elapsedMs=round((time.monotonic() - started) * 1000), **details)

    try:
        with request.urlopen(req, timeout=timeout) as resp:
            details['httpStatus'] = resp.status
            body = resp.read().decode('utf-8')
            return json.loads(body) if body else {}
    except error.HTTPError as exc:
        details['httpStatus'] = exc.code
        detail = _http_error_detail(exc, sensitive)
        if detail:
            details['serverError'] = detail
        raise failure('http_error', f'HTTP {exc.code}') from exc
    except (TimeoutError, error.URLError) as exc:
        reason = exc.reason if isinstance(exc, error.URLError) else exc
        timed_out = isinstance(reason, TimeoutError)
        details['reasonType'] = type(reason).__name__
        if isinstance(reason, OSError):
            details['errno'] = reason.errno
            details['reason'] = _safe_error_detail(reason.strerror, sensitive)
        raise failure(
            'request_timeout' if timed_out else 'connection_error',
            'Request timed out' if timed_out else 'Connection failed',
        ) from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        if isinstance(exc, json.JSONDecodeError):
            details.update(jsonLine=exc.lineno, jsonColumn=exc.colno)
        raise failure('invalid_response_json', 'Response was not valid UTF-8 JSON') from exc
    except OSError as exc:
        details.update(errno=exc.errno, reason=_safe_error_detail(exc.strerror, sensitive))
        raise failure('connection_error', 'Response could not be read') from exc


def _emit_failure(exc, stage, started):
    code = exc.code if isinstance(exc, HookFailure) else 'unexpected_error'
    stage = exc.stage if isinstance(exc, HookFailure) else stage
    details = dict(exc.details) if isinstance(exc, HookFailure) else {}
    # Frame metadata only: traceback text includes source lines and can expose data.
    frames = traceback.extract_tb(exc.__traceback__)
    if frames:
        frame = frames[-1]
        details['location'] = f'{frame.name}:{frame.lineno}'
    chain = []
    current = exc
    seen = set()
    while current is not None and id(current) not in seen and len(chain) < 4:
        seen.add(id(current))
        chain.append(type(current).__name__)
        current = current.__cause__
    details['exceptionTypes'] = chain
    details['totalElapsedMs'] = round((time.monotonic() - started) * 1000)
    details.update(stage=stage, provider=PROVIDER, model=MODEL)
    cause = str(exc) if isinstance(exc, HookFailure) else type(exc).__name__
    summary = f'root_note_stop: {stage}: {cause}'
    if details.get('serverError'):
        summary += ': ' + details['serverError']
    # Existing runner persists stdout as a stable outcome and uses stderr for its
    # error summary. Keep the latter short, with the structured evidence in stdout.
    print(json.dumps({'outcomeCode': code, 'outcomeSummary': summary, 'diagnostic': details}))
    print(summary, file=sys.stderr)


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
    return '## branch note - latest turn\n- ' + seed


def _sanitize_note_color(value):
    """Return a canonical preset hex color, or None when the model did not
    provide (or provided an invalid) choice. Case-insensitive so models that
    emit uppercase hex still persist the canonical lowercase preset value."""
    normalized = _safe_text(value).strip().lower()
    for preset in NOTE_COLOR_PRESETS:
        if normalized == preset.lower():
            return preset
    return None


def _emit_outcome(outcome_code, outcome_summary, additional_context=''):
    result = {
        'outcomeCode': outcome_code,
        'outcomeSummary': outcome_summary,
    }
    if additional_context:
        result['additionalContext'] = f'[root_note_stop] {additional_context}'
    print(json.dumps(result))


def main():
    started = time.monotonic()
    stage = 'read_input'
    try:
        payload = json.load(sys.stdin)
    except Exception:
        _emit_outcome('missing_callback_context', 'Hook input was not valid JSON.')
        return

    try:
        if not isinstance(payload, dict):
            _emit_outcome('missing_callback_context', 'Hook input did not contain a callback object.')
            return
        if payload.get('hook_event_name') != 'Stop':
            _emit_outcome('ignored_event', 'Hook event was not Stop.')
            return

        lookup = payload.get('lookup') if isinstance(payload.get('lookup'), dict) else {}
        local_api_base = _safe_text(lookup.get('local_api_base')).rstrip('/')
        conversation_id = _safe_text(payload.get('conversation_id'))
        lineage = payload.get('lineage') if isinstance(payload.get('lineage'), dict) else {}
        turn = payload.get('turn') if isinstance(payload.get('turn'), dict) else {}

        if not local_api_base or not conversation_id:
            _emit_outcome('missing_callback_context', 'Required callback context was unavailable.')
            return

        lineage_root_message_id = _safe_text(lineage.get('root_message_id'))
        current_message_id = _safe_text(payload.get('message_id'))
        current_parent_id = _safe_text(payload.get('parent_id'))
        last_user_message_id = _safe_text(turn.get('last_user_message_id'))
        last_assistant_message_id = _safe_text(turn.get('last_assistant_message_id'))
        last_assistant_text = _safe_text(payload.get('last_assistant_message'))

        stage = 'fetch_messages'
        messages = _json_request(f'{local_api_base}/app/conversations/{conversation_id}/messages', stage=stage)
        if not isinstance(messages, list):
            raise HookFailure('invalid_response_shape', stage, 'Expected a messages array', responseType=type(messages).__name__)
        if not messages:
            _emit_outcome('messages_unavailable', 'Conversation messages were unavailable.')
            return

        message_by_id = {str(m.get('id')): m for m in messages if isinstance(m, dict) and m.get('id') is not None}

        def _hydrate_message(message_id):
            message_id = _safe_text(message_id)
            if not message_id:
                return None
            existing = message_by_id.get(message_id)
            if isinstance(existing, dict):
                return existing
            hydrate_error = None
            try:
                fetched = _json_request(f'{local_api_base}/app/messages/{message_id}', stage='hydrate_message')
            except Exception as exc:
                hydrate_error = exc
                fetched = None
            if isinstance(fetched, dict) and fetched.get('id') is not None:
                message_by_id[str(fetched.get('id'))] = fetched
                return fetched
            if hydrate_error is not None:
                raise hydrate_error
            return None

        def _root_from(message_id):
            current = _hydrate_message(message_id)
            visited = set()
            while isinstance(current, dict):
                current_id = _safe_text(current.get('id'))
                if not current_id or current_id in visited:
                    break
                visited.add(current_id)
                parent_id = current.get('parent_id')
                if parent_id is None:
                    return current
                current = _hydrate_message(parent_id)
            return None

        stage = 'resolve_root'
        conversation_root_message = (
            _root_from(current_message_id)
            or _root_from(last_user_message_id)
            or _root_from(last_assistant_message_id)
        )

        if conversation_root_message is None and current_parent_id:
            conversation_root_message = _root_from(current_parent_id)

        if conversation_root_message is None:
            root_candidates = [m for m in messages if isinstance(m, dict) and m.get('parent_id') is None]
            conversation_root_message = root_candidates[0] if root_candidates else None

        if not conversation_root_message:
            _emit_outcome('no_branch_anchor', 'No branch root message could be resolved.')
            return

        conversation_root_message_id = str(conversation_root_message.get('id'))

        def _ancestor_chain_from(message_id):
            current = _hydrate_message(message_id)
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
                current = _hydrate_message(parent_id)
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

            # Walk latest -> older and attach the note to the first user message whose
            # parent already has multiple children. This treats the nearest branch point
            # on the current route as the note anchor.
            for candidate in chain:
                if not _is_user_message(candidate):
                    continue
                parent_id = candidate.get('parent_id')
                if parent_id is None:
                    # Root-level branches have no parent to count children from.
                    # Treat multiple root user messages in the same conversation as
                    # a branch set and allow the current root user message to be the
                    # note anchor.
                    root_user_count = sum(
                        1
                        for item in messages
                        if _is_user_message(item) and item.get('parent_id') is None
                    )
                    if root_user_count > 1:
                        return candidate
                    continue
                if _child_count(parent_id) > 1:
                    return candidate

            # No branch point on this path. Do not create/update notes for normal
            # linear sends; this hook should only do work after branching.
            return None

        stage = 'resolve_branch_anchor'
        path_anchor_id = last_user_message_id or current_parent_id or current_message_id or last_assistant_message_id
        note_anchor_message = _branch_anchor_from(path_anchor_id)
        note_anchor_message_source = 'nearest_branch_scan' if note_anchor_message is not None else 'none'

        if note_anchor_message is None:
            _emit_outcome('no_branch_anchor', 'The current path has no branch note anchor.')
            return

        note_anchor_message_id = str(note_anchor_message.get('id'))
        anchor_message_content = _safe_text(note_anchor_message.get('content'))
        existing_note = _safe_text(note_anchor_message.get('note'))

        stage = 'load_latest_turn'
        last_user_message = _hydrate_message(last_user_message_id) if last_user_message_id else None
        last_assistant_message = _hydrate_message(last_assistant_message_id) if last_assistant_message_id else None

        latest_user_text = _safe_text((last_user_message or {}).get('content'))
        latest_assistant_text = _safe_text((last_assistant_message or {}).get('content')) or last_assistant_text

        if not latest_user_text and not latest_assistant_text:
            _emit_outcome('messages_unavailable', 'The latest turn text was unavailable.')
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

        stage = 'generate_note'
        sensitive = (model_input, SYSTEM_PROMPT, existing_note, anchor_message_content, latest_user_text, latest_assistant_text)
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
            stage=stage,
            sensitive=sensitive,
        )

        stage = 'parse_generation'
        if not isinstance(generation, dict) or not isinstance(generation.get('text'), str):
            raise HookFailure('invalid_response_shape', stage, 'Expected a generation object with a text string', responseType=type(generation).__name__)
        model_text = _safe_text(generation.get('text'))
        model_json = _parse_model_json(model_text)
        if not isinstance(model_json, dict):
            raise HookFailure('invalid_model_json', stage, 'Model did not return a JSON object', textLength=len(model_text))

        updated = bool(model_json.get('updated'))
        next_note = _safe_text(model_json.get('note')).strip()
        # A color is assigned only when the note is first created. Existing-note
        # updates preserve their already-persisted note_color regardless of model output.
        next_note_color = _sanitize_note_color(model_json.get('note_color')) if not existing_note else None

        # Prefer model output whenever present.
        # If model asks for no update but there is no note yet, create a small fallback note
        # so new branch roots reliably get a visible pill.
        if not next_note and not existing_note:
            next_note = _fallback_note(latest_user_text, latest_assistant_text)

        if not next_note or next_note == existing_note:
            _emit_outcome(
                'unchanged',
                'The existing branch note already reflects the latest turn.',
                f'anchor={note_anchor_message_id} source={note_anchor_message_source}',
            )
            return

        put_payload = {'note': next_note}
        if next_note_color is not None:
            put_payload['note_color'] = next_note_color

        stage = 'save_note'
        _json_request(
            f'{local_api_base}/app/messages/{note_anchor_message_id}',
            method='PUT',
            payload=put_payload,
            timeout=20,
            stage=stage,
            sensitive=(*sensitive, next_note),
        )

        _emit_outcome(
            'updated',
            'The branch note was updated.',
            f'anchor={note_anchor_message_id} len={len(next_note)}',
        )
    except Exception as exc:
        _emit_failure(exc, stage, started)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
