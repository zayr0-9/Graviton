import json
import os
import re
import sys
from datetime import datetime, timedelta
from urllib import request, error

MODEL = 'gpt-5.4-mini'
PROVIDER = 'openai'
MAX_MEMORY_CHARS = 10000
MAX_ENTRY_CHARS = 500
MAX_ENTRIES_PER_TURN = 3
RECENT_MEMORY_CONTEXT_CHARS = 10000
RECENT_MEMORY_MAX_CHARS = 25000
RECENT_MEMORY_MAX_ENTRY_CHARS = 500
RECENT_MEMORY_MAX_ENTRIES_PER_TURN = 3
RECENT_MEMORY_WINDOW_DAYS = 122
PROJECT_MEMORY_CONTEXT_CHARS = 12000
PROJECT_MEMORY_MAX_CHARS = 30000
PROJECT_MEMORY_MAX_ENTRY_CHARS = 500
PROJECT_MEMORY_MAX_ENTRIES_PER_TURN = 3

SYSTEM_PROMPT = '''You are a judge-only global long-term memory maintenance agent. You are not a chat assistant.

Do not answer the user, continue the conversation, summarize the turn, explain your reasoning, or produce any prose response. Your only job is to decide whether the latest hook event contains durable, user-level information that should be written to global long-term memory.

The caller will provide the current date and may provide project context. Use the date only to understand temporal context. Use project context only to avoid storing project-scoped facts in global memory.

Be extremely conservative. Most turns should produce no memory update.

Add global memory only for stable, reusable facts such as:
- The user's overarching goals, long-term plans, or broad ongoing initiatives that span projects.
- Durable user preferences, work style, communication preferences, or tool preferences that apply generally.
- Durable configuration details that are not tied to one project: hardware, OS, editor, shell, package manager, or recurring local environment facts.
- Long-term personal details the user explicitly shares and that may help future assistance.
- Cross-project development context that is clearly reusable beyond the current project.

Do NOT add:
- Project-specific facts about the codebase/repository currently being worked on; these belong in project_memory.md.
- Project-specific file paths, hook names, modules, bugs, architecture, implementation details, or debugging context.
- Upcoming events or time-bounded reminders; these belong in recent_memory.md.
- One-off requests.
- Temporary implementation steps.
- Routine command outputs.
- Generic preferences inferred from a single turn.
- Secrets, API keys, tokens, passwords, private keys, or sensitive credential values.
- Speculative facts.
- Duplicate facts already present in memory.
- Assistant claims unless the user confirmed them or they are direct outcomes of work in the conversation.

If there is no clear global long-term memory to write, output exactly this single line and nothing else:
no relevant context

If there is memory to write, output compact JSON only:
{"updated":true,"entries":["- durable memory bullet 1","- durable memory bullet 2"],"reason":"short reason"}

Rules for update JSON:
- entries must be concise standalone bullets that will still make sense months later.
- Prefer factual phrasing and avoid explanations.
- If a fact updates or corrects existing memory, output a replacement/correction entry rather than duplicating.
- Do not include markdown fences.
- Do not output updated=false JSON; use exactly `no relevant context` instead.
'''

PROJECT_MEMORY_SYSTEM_PROMPT = '''You are a judge-only project memory maintenance agent. You are not a chat assistant.

Do not answer the user, continue the conversation, summarize the turn, explain your reasoning, or produce any prose response. Your only job is to decide whether the latest hook event contains project-specific information that should be written to the current project's memory file.

The caller will provide:
- current date and timestamp
- project id and project name
- global long-term memory
- recent global memory
- existing memory for this project
- latest user and assistant messages

Be extremely conservative. Most turns should produce no project memory update.

Project memory is only for high-value lessons that are hard to rediscover and likely to prevent future mistakes in this same project.

Add project memory only for durable project-specific facts such as:
- Very important architectural decisions, invariants, subsystem boundaries, or data-flow constraints that future work must preserve.
- Non-obvious local tooling or shell idiosyncrasies, especially bash/WSL/Windows/path quirks or command forms that repeatedly matter in this repository.
- Build, test, packaging, or runtime fixes that the user or assistant struggled to discover and that are likely to recur.
- Explicit user instructions that define long-term project policy or workflow for this repository.

Do NOT add:
- General personal facts or global preferences that belong in long-term memory.
- Upcoming events or time-bounded reminders that belong in recent memory.
- Feature additions, routine implementation details, code changes, refactors, or completed tasks.
- File/module changes unless they encode a lasting architectural invariant or hard-won operational lesson.
- Project-specific goals, roadmap items, ordinary bugs, blockers, or constraints unless they are long-lived architectural constraints.
- Decisions that only affect the current feature or short-lived implementation plan.
- One-off commands, transient logs, or temporary scratch work.
- Generic facts that can be inferred from the repository every time.
- Secrets, API keys, tokens, passwords, private keys, or sensitive credential values.
- Speculative facts.
- Duplicate facts already present in project memory.
- Assistant claims unless the user confirmed them or they are direct outcomes of a validated fix or decision in the conversation.

If there is no clear project memory to write, output exactly this single line and nothing else:
no relevant context

If there is project memory to write, output compact JSON only:
{"updated":true,"entries":["- project memory bullet 1","- project memory bullet 2"],"reason":"short reason"}

Rules for update JSON:
- entries must be concise standalone bullets that make sense weeks later in this same project.
- Prefer factual phrasing and avoid explanations.
- If a fact updates or corrects existing project memory, output a replacement/correction entry rather than duplicating.
- Do not include markdown fences.
- Do not output updated=false JSON; use exactly `no relevant context` instead.
'''

RECENT_MEMORY_SYSTEM_PROMPT = '''You are a judge-only recent memory maintenance agent. You are not a chat assistant.

Do not answer the user, continue the conversation, summarize the turn, explain your reasoning, or produce any prose response. Your only job is to decide whether the latest hook event contains short-lived user-level context that should be written to recent_memory.md.

Recent memory is a near-term companion to global long-term memory. It is for user-level facts that are useful soon but should not live forever. It is NOT project memory and must not duplicate project_memory.md.

The caller will provide the current date and timestamp. Use them to decide whether something belongs in recent memory and to resolve relative dates when possible.

Be very conservative. Most turns should produce no recent memory update.

Add recent memory only for near-term, user-level facts such as:
- Upcoming user events, meetings, calls, interviews, appointments, deadlines, launches, trips, demos, exams, presentations, or applications.
- Near-term personal/professional plans, commitments, obligations, or decisions that matter over the next days, weeks, or up to 4 months.
- Temporary user-level constraints or availability details, such as travel, visas, funding deadlines, health constraints, scheduling limits, or time-sensitive preferences.
- Active non-project-specific goals or priorities the user explicitly wants remembered soon.
- Event details with dates/times, participants, locations, links, preparation requirements, or status when explicitly available.

Do NOT add project/codebase/repository details. These belong in project_memory.md, not recent_memory.md. In particular, do NOT add:
- File paths, filenames, modules, functions, endpoints, hooks, components, providers, tests, commands, logs, stack traces, or implementation plans.
- Debugging/investigation status for a specific repo or codebase.
- Architecture decisions, UI requirements, local-server routes, prompt edits, memory-hook behavior, stream-resilience details, or other development context tied to the current project.
- Short-term coding tasks like “plan to add endpoint X”, “need to keep UI clean”, “investigating provider Y”, or “relevant files are ...”.
- Anything that would only be useful when working in the current repository; project memory handles that.

Also do NOT add:
- Durable facts that belong in global long-term memory.
- One-off implementation details with no user-level future value.
- Routine command outputs.
- Generic preferences inferred from one turn.
- Completed events that no longer matter.
- Events more than 4 months away unless the user clearly says they are important to track now.
- Secrets, API keys, tokens, passwords, private keys, or sensitive credential values.
- Speculative facts.
- Duplicate facts already present in recent memory.
- Assistant claims unless the user confirmed them or they are direct outcomes of the conversation.

If there is no clear recent user-level memory to write, output exactly this single line and nothing else:
no relevant context

If there is recent memory to write, output compact JSON only:
{"updated":true,"entries":["short recent user-level memory item 1","short recent user-level memory item 2"],"reason":"short reason"}

Rules for update JSON:
- entries must be concise, actionable, user-level, and date-aware.
- If an event has a known date/time, include it.
- If the date is relative, resolve it using the provided current date when possible.
- If timing is unclear but important soon, say that timing is unspecified.
- If a new turn updates or cancels an existing item, output a concise replacement/correction/cancellation entry.
- Do not include markdown fences.
- Do not output updated=false JSON; use exactly `no relevant context` instead.
'''

SECRET_PATTERNS = (
    'api key', 'apikey', 'secret key', 'access token', 'refresh token', 'password',
    'private key', 'bearer ', 'authorization:', 'ssh-rsa ', '-----begin ',
)
RECENT_ENTRY_RE = re.compile(r'^- \[(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\]\s+(.*)$')
DEBUG_MESSAGES = []
OUTCOME_UPDATED = False


def _json_request(url, method='GET', payload=None, timeout=20):
    data = None
    headers = {'Content-Type': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8')
            return json.loads(body) if body else {}
    except error.HTTPError as http_error:
        status = getattr(http_error, 'code', '?')
        raise RuntimeError(f'callback request failed with HTTP status {status}') from http_error


def _safe_text(value):
    return value if isinstance(value, str) else ''


def _parse_model_json(text):
    text = (text or '').strip()
    if not text:
        return None
    if text.lower() == 'no relevant context':
        return {'updated': False, 'entries': [], 'reason': 'no relevant context'}
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


def _truncate_inline(text, limit=220):
    collapsed = ' '.join(_safe_text(text).split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: max(limit - 3, 0)] + '...'


def _debug_enabled():
    return any(
        os.environ.get(name, '').lower() in ('1', 'true', 'yes', 'on')
        for name in ('YGG_HOOK_DEBUG_LOGS', 'YGG_MEMORY_HOOK_DEBUG')
    )


def _emit_debug(message, **details):
    if not _debug_enabled():
        return
    detail_parts = []
    for key, value in details.items():
        if value is None or value == '':
            continue
        detail_parts.append(f'{key}={_truncate_inline(str(value), 260)}')
    suffix = f' ({", ".join(detail_parts)})' if detail_parts else ''
    DEBUG_MESSAGES.append(f'[long_term_memory_stop] {message}{suffix}')


def _emit_outcome(outcome_code, outcome_summary, additional_context=''):
    result = {
        'outcomeCode': outcome_code,
        'outcomeSummary': outcome_summary,
    }
    if additional_context:
        result['additionalContext'] = additional_context
    print(json.dumps(result))


def _flush_result():
    outcome_code = 'updated' if OUTCOME_UPDATED else 'unchanged'
    outcome_summary = 'Memory files were updated.' if OUTCOME_UPDATED else 'No memory changes were needed.'
    _emit_outcome(
        outcome_code,
        outcome_summary,
        '\n\n'.join(DEBUG_MESSAGES) if DEBUG_MESSAGES else '',
    )


def _memory_directory():
    # Hook commands execute with cwd set to the parent of the managed .ygg directory
    # (Electron userData in normal app runs). Do not use payload.cwd here; that is the
    # active tool/workspace cwd and would put memory in project folders instead.
    return os.path.join(os.getcwd(), '.ygg', 'memory')


def _memory_file_path():
    return os.path.join(_memory_directory(), 'memory.md')


def _recent_memory_file_path():
    return os.path.join(_memory_directory(), 'recent_memory.md')


def _safe_project_directory_name(project_name, project_id):
    raw = _safe_text(project_name).strip() or _safe_text(project_id).strip()
    if not raw:
        return ''
    name = re.sub(r'[\\/\0:*?"<>|]+', '-', raw)
    name = re.sub(r'\s+', ' ', name).strip().strip('. ')
    if len(name) > 80:
        name = name[:80].rstrip().strip('. ')
    return name


def _project_memory_file_path(project_name, project_id):
    safe_name = _safe_project_directory_name(project_name, project_id)
    if not safe_name:
        return ''
    return os.path.join(_memory_directory(), 'projects', safe_name, 'project_memory.md')


def _read_memory(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return handle.read()
    except FileNotFoundError:
        return ''


def _current_time_details():
    now = datetime.now()
    return now, now.date().isoformat(), now.strftime('%Y-%m-%d-%H-%M')


def _normalize_entry(value):
    entry = _safe_text(value).strip()
    if not entry:
        return ''
    entry = ' '.join(entry.split())
    if not entry.startswith('- '):
        entry = '- ' + entry.lstrip('- ').strip()
    if len(entry) > MAX_ENTRY_CHARS:
        entry = entry[: MAX_ENTRY_CHARS - 3].rstrip() + '...'
    lowered = entry.lower()
    if any(pattern in lowered for pattern in SECRET_PATTERNS):
        return ''
    return entry


def _normalize_project_entry(value):
    entry = _safe_text(value).strip()
    if not entry:
        return ''
    entry = ' '.join(entry.split())
    if not entry.startswith('- '):
        entry = '- ' + entry.lstrip('- ').strip()
    if len(entry) > PROJECT_MEMORY_MAX_ENTRY_CHARS:
        entry = entry[: PROJECT_MEMORY_MAX_ENTRY_CHARS - 3].rstrip() + '...'
    lowered = entry.lower()
    if any(pattern in lowered for pattern in SECRET_PATTERNS):
        return ''
    return entry


def _normalize_recent_entry(value):
    entry = _safe_text(value).strip()
    if not entry:
        return ''
    entry = ' '.join(entry.split())
    entry = entry.lstrip('- ').strip()
    entry = re.sub(r'^\[\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\]\s*', '', entry).strip()
    if not entry:
        return ''
    if len(entry) > RECENT_MEMORY_MAX_ENTRY_CHARS:
        entry = entry[: RECENT_MEMORY_MAX_ENTRY_CHARS - 3].rstrip() + '...'
    lowered = entry.lower()
    if any(pattern in lowered for pattern in SECRET_PATTERNS):
        return ''
    return entry


def _append_entries(memory_text, entries, current_date):
    header = f'## {current_date}'
    existing_lines = {line.strip().lower() for line in memory_text.splitlines() if line.strip().startswith('- ')}
    unique_entries = []
    for raw in entries:
        entry = _normalize_entry(raw)
        if not entry:
            continue
        key = entry.strip().lower()
        if key in existing_lines or key in {item.lower() for item in unique_entries}:
            continue
        unique_entries.append(entry)
        if len(unique_entries) >= MAX_ENTRIES_PER_TURN:
            break

    if not unique_entries:
        return memory_text, []

    current = memory_text.strip()
    if not current:
        current = '# Long-term memory'

    if header in current.splitlines():
        lines = current.splitlines()
        insert_at = len(lines)
        for index, line in enumerate(lines):
            if index > 0 and line.startswith('## ') and line.strip() != header:
                # Only insert before a later section if today's section appears earlier.
                if any(prev.strip() == header for prev in lines[:index]):
                    insert_at = index
                    break
        lines[insert_at:insert_at] = unique_entries
        return '\n'.join(lines).rstrip() + '\n', unique_entries

    next_text = current.rstrip() + f'\n\n{header}\n' + '\n'.join(unique_entries) + '\n'
    return next_text, unique_entries


def _recent_entry_text_key(line):
    match = RECENT_ENTRY_RE.match(line.strip())
    if match:
        return match.group(2).strip().lower()
    return line.strip().lower()


def _prune_recent_memory(content, now):
    lines = content.splitlines()
    entries = []
    cutoff = now - timedelta(days=RECENT_MEMORY_WINDOW_DAYS)
    pruned_by_age = 0

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped == '# Recent memory':
            continue
        if not stripped.startswith('- '):
            continue
        match = RECENT_ENTRY_RE.match(stripped)
        if match:
            try:
                timestamp = datetime.strptime(match.group(1), '%Y-%m-%d-%H-%M')
            except ValueError:
                pruned_by_age += 1
                continue
            if timestamp < cutoff:
                pruned_by_age += 1
                continue
        entries.append(stripped)

    pruned_by_size = 0
    while entries:
        candidate = '# Recent memory\n\n' + '\n'.join(entries) + '\n'
        if len(candidate) <= RECENT_MEMORY_MAX_CHARS:
            return candidate, pruned_by_age, pruned_by_size
        entries.pop(0)
        pruned_by_size += 1

    return '# Recent memory\n', pruned_by_age, pruned_by_size


def _append_recent_entries(recent_memory_text, entries, current_timestamp, now):
    existing_keys = {
        _recent_entry_text_key(line)
        for line in recent_memory_text.splitlines()
        if line.strip().startswith('- ')
    }
    unique_entries = []
    for raw in entries:
        entry = _normalize_recent_entry(raw)
        if not entry:
            continue
        key = entry.strip().lower()
        if key in existing_keys or key in {item.lower() for item in unique_entries}:
            continue
        unique_entries.append(entry)
        if len(unique_entries) >= RECENT_MEMORY_MAX_ENTRIES_PER_TURN:
            break

    if not unique_entries:
        pruned, pruned_by_age, pruned_by_size = _prune_recent_memory(recent_memory_text or '# Recent memory\n', now)
        return pruned, [], pruned_by_age, pruned_by_size

    current = recent_memory_text.strip()
    if not current:
        current = '# Recent memory'

    appended_lines = [f'- [{current_timestamp}] {entry}' for entry in unique_entries]
    next_text = current.rstrip() + '\n' + '\n'.join(appended_lines) + '\n'
    next_text, pruned_by_age, pruned_by_size = _prune_recent_memory(next_text, now)
    return next_text, appended_lines, pruned_by_age, pruned_by_size


def _project_memory_header(project_name, project_id):
    title = _safe_text(project_name).strip() or _safe_text(project_id).strip() or 'Unknown project'
    lines = [f'# Project memory: {title}']
    if _safe_text(project_id).strip():
        lines.append(f'<!-- project_id: {_safe_text(project_id).strip()} -->')
    return '\n'.join(lines)


def _prune_project_memory(content):
    if len(content) <= PROJECT_MEMORY_MAX_CHARS:
        return content, 0
    lines = content.splitlines()
    preserved = []
    entries = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('# Project memory') or stripped.startswith('<!-- project_id:') or stripped.startswith('## '):
            preserved.append(line)
        elif stripped.startswith('- '):
            entries.append(line)
        elif stripped:
            preserved.append(line)
    pruned = 0
    while entries:
        candidate = '\n'.join(preserved + entries).rstrip() + '\n'
        if len(candidate) <= PROJECT_MEMORY_MAX_CHARS:
            return candidate, pruned
        entries.pop(0)
        pruned += 1
    return '\n'.join(preserved).rstrip() + '\n', pruned


def _append_project_entries(project_memory_text, entries, current_date, project_name, project_id):
    header = f'## {current_date}'
    existing_lines = {line.strip().lower() for line in project_memory_text.splitlines() if line.strip().startswith('- ')}
    unique_entries = []
    for raw in entries:
        entry = _normalize_project_entry(raw)
        if not entry:
            continue
        key = entry.strip().lower()
        if key in existing_lines or key in {item.lower() for item in unique_entries}:
            continue
        unique_entries.append(entry)
        if len(unique_entries) >= PROJECT_MEMORY_MAX_ENTRIES_PER_TURN:
            break

    if not unique_entries:
        return project_memory_text, [], 0

    current = project_memory_text.strip()
    if not current:
        current = _project_memory_header(project_name, project_id)

    if header in current.splitlines():
        lines = current.splitlines()
        insert_at = len(lines)
        for index, line in enumerate(lines):
            if index > 0 and line.startswith('## ') and line.strip() != header:
                if any(prev.strip() == header for prev in lines[:index]):
                    insert_at = index
                    break
        lines[insert_at:insert_at] = unique_entries
        next_text = '\n'.join(lines).rstrip() + '\n'
    else:
        next_text = current.rstrip() + f'\n\n{header}\n' + '\n'.join(unique_entries) + '\n'
    next_text, pruned = _prune_project_memory(next_text)
    return next_text, unique_entries, pruned


def _atomic_write(path, content):
    global OUTCOME_UPDATED
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f'{path}.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as handle:
        handle.write(content)
    os.replace(tmp_path, path)
    OUTCOME_UPDATED = True


def _generate_memory_json(local_api_base, system_prompt, model_input):
    generation = _json_request(
        f'{local_api_base}/headless/ygg-hooks/generate',
        method='POST',
        payload={
            'provider': PROVIDER,
            'modelName': MODEL,
            'systemPrompt': system_prompt,
            'content': model_input,
        },
        timeout=45,
    )
    return generation, _parse_model_json(_safe_text(generation.get('text')))


def _run_long_term_memory_update(local_api_base, memory_path, memory_text, latest_user_text, latest_assistant_text, current_date, current_timestamp, project_id, project_name, debug_details):
    recent_memory = memory_text[-MAX_MEMORY_CHARS:]
    model_input = (
        f'Current date: {current_date}\n'
        f'Current timestamp: {current_timestamp}\n'
        f'Current project id: {project_id or "<none>"}\n'
        f'Current project name: {project_name or "<none>"}\n\n'
        'Recent existing long-term memory excerpt (most recent content, may be empty):\n'
        f'{recent_memory or "<empty>"}\n\n'
        'Latest user message / submitted prompt:\n'
        f'{latest_user_text or "<empty>"}\n\n'
        'Latest assistant message, if this is a Stop event:\n'
        f'{latest_assistant_text or "<empty>"}\n\n'
        'Judge only. If there is no durable global long-term memory to write, return exactly: no relevant context'
    )

    generation, model_json = _generate_memory_json(local_api_base, SYSTEM_PROMPT, model_input)
    if not isinstance(model_json, dict):
        raise RuntimeError('long-term memory generation returned invalid JSON')

    if not bool(model_json.get('updated')):
        _emit_debug(
            f'long_term_fired_then_skipped: { _truncate_inline(_safe_text(model_json.get("reason"))) or "no update" }',
            **debug_details,
        )
        return memory_text

    entries = model_json.get('entries')
    if not isinstance(entries, list):
        raise RuntimeError('long-term memory generation returned invalid entries')

    next_memory, appended = _append_entries(memory_text, entries, current_date)
    if not appended or next_memory == memory_text:
        _emit_debug('long_term_fired_then_skipped: no unique safe entries', candidate_entries=len(entries), **debug_details)
        return memory_text

    _atomic_write(memory_path, next_memory)
    _emit_debug('long_term_fired_and_updated', appended=len(appended), **debug_details)
    return next_memory


def _run_project_memory_update(local_api_base, project_memory_path, project_id, project_name, memory_text, recent_memory_text, project_memory_text, latest_user_text, latest_assistant_text, current_date, current_timestamp, debug_details):
    if not project_memory_path:
        _emit_debug('project_memory_skipped: no project context', project_id=project_id or '<missing>', project_name=project_name or '<missing>', **debug_details)
        return project_memory_text

    long_term_excerpt = memory_text[-MAX_MEMORY_CHARS:]
    recent_memory_excerpt = recent_memory_text[-RECENT_MEMORY_CONTEXT_CHARS:]
    project_memory_excerpt = project_memory_text[-PROJECT_MEMORY_CONTEXT_CHARS:]
    project_debug_details = {
        **debug_details,
        'project_id': project_id or '<missing>',
        'project_name': project_name or '<missing>',
        'project_memory_path': project_memory_path,
        'project_memory_chars': len(project_memory_text),
    }
    model_input = (
        f'Current date: {current_date}\n'
        f'Current timestamp: {current_timestamp}\n\n'
        'Project context:\n'
        f'- id: {project_id or "<missing>"}\n'
        f'- name: {project_name or "<missing>"}\n\n'
        'Global long-term memory excerpt (context only, may be empty):\n'
        f'{long_term_excerpt or "<empty>"}\n\n'
        'Recent global memory excerpt (context only, may be empty):\n'
        f'{recent_memory_excerpt or "<empty>"}\n\n'
        'Existing project memory (may be empty):\n'
        f'{project_memory_excerpt or "<empty>"}\n\n'
        'Latest user message / submitted prompt:\n'
        f'{latest_user_text or "<empty>"}\n\n'
        'Latest assistant message, if this is a Stop event:\n'
        f'{latest_assistant_text or "<empty>"}\n\n'
        'Project-memory boundary reminder: write only very important architectural decisions, hard-won build/test/runtime fixes, '\
        'non-obvious bash/WSL/path/command idiosyncrasies, or explicit long-term project policy. Do not store feature additions, '\
        'routine implementation details, ordinary code changes, or short-lived plans. Judge only. If there is no useful project-specific memory to write, '\
        'return exactly: no relevant context'
    )

    generation, model_json = _generate_memory_json(local_api_base, PROJECT_MEMORY_SYSTEM_PROMPT, model_input)
    if not isinstance(model_json, dict):
        raise RuntimeError('project memory generation returned invalid JSON')

    if not bool(model_json.get('updated')):
        _emit_debug(f'project_memory_fired_then_skipped: { _truncate_inline(_safe_text(model_json.get("reason"))) or "no update" }', **project_debug_details)
        return project_memory_text

    entries = model_json.get('entries')
    if not isinstance(entries, list):
        raise RuntimeError('project memory generation returned invalid entries')

    next_project_memory, appended, pruned = _append_project_entries(project_memory_text, entries, current_date, project_name, project_id)
    if not appended or next_project_memory == project_memory_text:
        _emit_debug('project_memory_fired_then_skipped: no unique safe entries', candidate_entries=len(entries), **project_debug_details)
        return project_memory_text

    _atomic_write(project_memory_path, next_project_memory)
    _emit_debug('project_memory_fired_and_updated', appended=len(appended), pruned=pruned, **project_debug_details)
    return next_project_memory


def _run_recent_memory_update(local_api_base, recent_memory_path, memory_text, recent_memory_text, latest_user_text, latest_assistant_text, current_date, current_timestamp, now, debug_details):
    long_term_excerpt = memory_text[-MAX_MEMORY_CHARS:]
    recent_memory_excerpt = recent_memory_text[-RECENT_MEMORY_CONTEXT_CHARS:]
    recent_debug_details = {
        **debug_details,
        'recent_memory_path': recent_memory_path,
        'recent_memory_chars': len(recent_memory_text),
    }
    model_input = (
        f'Current date: {current_date}\n'
        f'Current timestamp for new recent-memory entries: {current_timestamp}\n'
        f'Recent-memory horizon: next {RECENT_MEMORY_WINDOW_DAYS} days, about 4 months maximum.\n\n'
        'Long-term memory excerpt (context only, may be empty):\n'
        f'{long_term_excerpt or "<empty>"}\n\n'
        'Existing recent memory (may be empty):\n'
        f'{recent_memory_excerpt or "<empty>"}\n\n'
        'Latest user message / submitted prompt:\n'
        f'{latest_user_text or "<empty>"}\n\n'
        f'Latest assistant message, if this is a Stop event:\n'
        f'{latest_assistant_text or "<empty>"}\n\n'
        'Boundary reminder: recent memory is only for near-term user-level context. '
        'Do not store repo/codebase/project implementation details, file paths, debugging status, or plans; '
        'those belong in project memory. Judge only. If there is no useful recent user-level memory to write, '
        'return exactly: no relevant context'
    )

    generation, model_json = _generate_memory_json(local_api_base, RECENT_MEMORY_SYSTEM_PROMPT, model_input)
    if not isinstance(model_json, dict):
        raise RuntimeError('recent memory generation returned invalid JSON')

    if not bool(model_json.get('updated')):
        pruned, pruned_by_age, pruned_by_size = _prune_recent_memory(recent_memory_text or '# Recent memory\n', now)
        if pruned != recent_memory_text and (recent_memory_text or pruned.strip() != '# Recent memory'):
            _atomic_write(recent_memory_path, pruned)
        _emit_debug(
            f'recent_memory_fired_then_skipped: { _truncate_inline(_safe_text(model_json.get("reason"))) or "no update" }',
            pruned_by_age=pruned_by_age,
            pruned_by_size=pruned_by_size,
            **recent_debug_details,
        )
        return pruned

    entries = model_json.get('entries')
    if not isinstance(entries, list):
        raise RuntimeError('recent memory generation returned invalid entries')

    next_recent_memory, appended, pruned_by_age, pruned_by_size = _append_recent_entries(
        recent_memory_text,
        entries,
        current_timestamp,
        now,
    )
    if not appended and next_recent_memory == recent_memory_text:
        _emit_debug('recent_memory_fired_then_skipped: no unique safe entries', candidate_entries=len(entries), **recent_debug_details)
        return recent_memory_text

    _atomic_write(recent_memory_path, next_recent_memory)
    if appended:
        _emit_debug(
            'recent_memory_fired_and_updated',
            appended=len(appended),
            pruned_by_age=pruned_by_age,
            pruned_by_size=pruned_by_size,
            **recent_debug_details,
        )
    else:
        _emit_debug(
            'recent_memory_fired_and_pruned',
            candidate_entries=len(entries),
            pruned_by_age=pruned_by_age,
            pruned_by_size=pruned_by_size,
            **recent_debug_details,
        )
    return next_recent_memory


def _extract_project_context(payload):
    project = payload.get('project') if isinstance(payload.get('project'), dict) else {}
    project_id = _safe_text(payload.get('project_id')) or _safe_text(project.get('project_id'))
    project_name = _safe_text(payload.get('project_name')) or _safe_text(project.get('project_name'))
    return project_id, project_name


def _resolve_project_context(local_api_base, conversation_id, payload):
    project_id, project_name = _extract_project_context(payload)
    if project_id and project_name:
        return project_id, project_name

    if local_api_base and conversation_id:
        try:
            conversation = _json_request(f'{local_api_base}/local/conversations/{conversation_id}', timeout=10)
            if isinstance(conversation, dict):
                project_id = project_id or _safe_text(conversation.get('project_id'))
        except Exception as exc:
            raise RuntimeError('project conversation context callback failed') from exc

    if local_api_base and project_id and not project_name:
        try:
            project = _json_request(f'{local_api_base}/local/projects/{project_id}', timeout=10)
            if isinstance(project, dict):
                project_name = _safe_text(project.get('name'))
        except Exception as exc:
            raise RuntimeError('project metadata callback failed') from exc

    return project_id, project_name


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        _emit_outcome('missing_callback_context', 'Hook input was not valid JSON.')
        return

    try:
        if not isinstance(payload, dict):
            _emit_outcome('missing_callback_context', 'Hook input did not contain a callback object.')
            return
        event_name = payload.get('hook_event_name')
        if event_name not in ('Stop', 'UserPromptSubmit'):
            _emit_outcome('ignored_event', 'Hook event was not supported.')
            return

        lookup = payload.get('lookup') if isinstance(payload.get('lookup'), dict) else {}
        local_api_base = _safe_text(lookup.get('local_api_base')).rstrip('/')
        conversation_id = _safe_text(payload.get('conversation_id'))
        turn = payload.get('turn') if isinstance(payload.get('turn'), dict) else {}
        last_user_message_id = _safe_text(turn.get('last_user_message_id'))
        last_assistant_message_id = _safe_text(turn.get('last_assistant_message_id'))
        last_assistant_text = _safe_text(payload.get('last_assistant_message'))
        submitted_prompt = _safe_text(payload.get('prompt'))

        memory_path = _memory_file_path()
        recent_memory_path = _recent_memory_file_path()
        now, current_date, current_timestamp = _current_time_details()
        project_id, project_name = _resolve_project_context(local_api_base, conversation_id, payload) if local_api_base and conversation_id else _extract_project_context(payload)
        project_memory_path = _project_memory_file_path(project_name, project_id)

        if not local_api_base or not conversation_id:
            _emit_debug(
                'fired_then_skipped: missing local_api_base or conversation_id',
                conversation_id=conversation_id or '<missing>',
                local_api_base=local_api_base or '<missing>',
                cwd=payload.get('cwd') or os.getcwd(),
                memory_path=memory_path,
                recent_memory_path=recent_memory_path,
                project_id=project_id or '<missing>',
                project_name=project_name or '<missing>',
                project_memory_path=project_memory_path or '<missing>',
            )
            _emit_outcome('missing_callback_context', 'Required callback context was unavailable.')
            return

        messages = []
        latest_user_text = submitted_prompt if event_name == 'UserPromptSubmit' else ''
        latest_assistant_text = '' if event_name == 'UserPromptSubmit' else last_assistant_text

        if event_name == 'Stop':
            messages = _json_request(f'{local_api_base}/app/conversations/{conversation_id}/messages')
            if not isinstance(messages, list):
                _emit_debug(
                    'fired_then_skipped: conversation messages unavailable',
                    event=event_name,
                    conversation_id=conversation_id,
                    local_api_base=local_api_base,
                    memory_path=memory_path,
                    recent_memory_path=recent_memory_path,
                )
                _emit_outcome('messages_unavailable', 'Conversation messages were unavailable.')
                return

            message_by_id = {str(m.get('id')): m for m in messages if isinstance(m, dict) and m.get('id') is not None}
            latest_user_text = _safe_text((message_by_id.get(last_user_message_id) or {}).get('content'))
            latest_assistant_text = _safe_text((message_by_id.get(last_assistant_message_id) or {}).get('content')) or last_assistant_text

        if not latest_user_text and not latest_assistant_text:
            _emit_debug(
                'fired_then_skipped: empty latest turn',
                conversation_id=conversation_id,
                last_user_message_id=last_user_message_id or '<missing>',
                last_assistant_message_id=last_assistant_message_id or '<missing>',
                messages=len(messages) if isinstance(messages, list) else 0,
                memory_path=memory_path,
                recent_memory_path=recent_memory_path,
            )
            _emit_outcome('messages_unavailable', 'The latest turn text was unavailable.')
            return

        memory_text = _read_memory(memory_path)
        recent_memory_text = _read_memory(recent_memory_path)
        project_memory_text = _read_memory(project_memory_path) if project_memory_path else ''

        debug_details = {
            'conversation_id': conversation_id,
            'event': event_name,
            'messages': len(messages) if isinstance(messages, list) else 0,
            'last_user_message_id': last_user_message_id or '<missing>',
            'last_assistant_message_id': last_assistant_message_id or '<missing>',
            'memory_path': memory_path,
            'memory_chars': len(memory_text),
            'latest_user_chars': len(latest_user_text),
            'latest_assistant_chars': len(latest_assistant_text),
            'current_date': current_date,
            'current_timestamp': current_timestamp,
            'project_id': project_id or '<missing>',
            'project_name': project_name or '<missing>',
            'project_memory_path': project_memory_path or '<missing>',
        }

        next_memory_text = _run_long_term_memory_update(
            local_api_base,
            memory_path,
            memory_text,
            latest_user_text,
            latest_assistant_text,
            current_date,
            current_timestamp,
            project_id,
            project_name,
            debug_details,
        )

        next_recent_memory_text = _run_recent_memory_update(
            local_api_base,
            recent_memory_path,
            next_memory_text,
            recent_memory_text,
            latest_user_text,
            latest_assistant_text,
            current_date,
            current_timestamp,
            now,
            {**debug_details, 'memory_chars': len(next_memory_text)},
        )

        _run_project_memory_update(
            local_api_base,
            project_memory_path,
            project_id,
            project_name,
            next_memory_text,
            next_recent_memory_text,
            project_memory_text,
            latest_user_text,
            latest_assistant_text,
            current_date,
            current_timestamp,
            {**debug_details, 'memory_chars': len(next_memory_text), 'recent_memory_chars': len(next_recent_memory_text)},
        )
        _flush_result()
    except Exception:
        print('long_term_memory_stop: callback, generation, parsing, or update failed', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
