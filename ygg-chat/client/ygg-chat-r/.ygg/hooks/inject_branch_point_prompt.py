import json
import sys
from urllib import request


def _safe_text(value):
    return value if isinstance(value, str) else ''


def _json_request(url, timeout=20):
    req = request.Request(url, headers={'Content-Type': 'application/json'}, method='GET')
    with request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode('utf-8')
        return json.loads(body) if body else {}


def _ancestor_chain_from(message_by_id, message_id):
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


def _child_count(messages, parent_message_id):
    parent_message_id = _safe_text(parent_message_id)
    if not parent_message_id:
        return 0
    return sum(1 for item in messages if isinstance(item, dict) and _safe_text(item.get('parent_id')) == parent_message_id)


def _find_branch_point_ancestor_id(messages, message_by_id, anchor_id):
    chain = _ancestor_chain_from(message_by_id, anchor_id)
    branching_user_candidates = []

    # Tip -> root. Keep the top-most branching entry on this path.
    for candidate in chain:
        if not _is_user_message(candidate):
            continue
        parent_id = candidate.get('parent_id')
        if parent_id is None:
            continue
        if _child_count(messages, parent_id) > 1:
            branching_user_candidates.append(candidate)

    if not branching_user_candidates:
        return ''

    top_branch_entry = branching_user_candidates[-1]
    return _safe_text(top_branch_entry.get('parent_id'))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print('{}')
        return

    try:
        if payload.get('hook_event_name') != 'UserPromptSubmit':
            print('{}')
            return

        prompt = _safe_text(payload.get('prompt'))
        if not prompt:
            print('{}')
            return

        if prompt.startswith('[branch_point_ancestor_id='):
            print('{}')
            return

        lookup = payload.get('lookup') or {}
        local_api_base = _safe_text(lookup.get('local_api_base')).rstrip('/')
        conversation_id = _safe_text(payload.get('conversation_id'))
        message_id = _safe_text(payload.get('message_id'))
        parent_id = _safe_text(payload.get('parent_id'))

        if not local_api_base or not conversation_id:
            print('{}')
            return

        messages = _json_request(f'{local_api_base}/app/conversations/{conversation_id}/messages')
        if not isinstance(messages, list) or not messages:
            print('{}')
            return

        message_by_id = {str(m.get('id')): m for m in messages if isinstance(m, dict) and m.get('id') is not None}

        # In UserPromptSubmit, parent_id is the best anchor for the route the new user message will attach to.
        # Fallback to message_id if parent_id is absent.
        path_anchor_id = parent_id or message_id
        branch_point_ancestor_id = _find_branch_point_ancestor_id(messages, message_by_id, path_anchor_id)

        if not branch_point_ancestor_id:
            print('{}')
            return

        updated_prompt = f'[branch_point_ancestor_id={branch_point_ancestor_id}]\n{prompt}'
        print(json.dumps({'updatedPrompt': updated_prompt}))
    except Exception:
        print('{}')


if __name__ == '__main__':
    main()
