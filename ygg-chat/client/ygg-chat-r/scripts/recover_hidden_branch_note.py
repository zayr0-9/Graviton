"""Copy one misplaced note to its human prompt; dry-run unless --apply.

Run only while the affected conversation is idle: the legacy PUT API has no
compare-and-swap, so the pre-write check cannot exclude concurrent edits.
Existing destination notes are refused and originals are retained as backups.
For shared prefixes, the operator must verify the last writer from hook logs
before supplying --writer-tip; ancestry alone cannot establish note ownership.
Recover before resuming the branch; if a new note exists, merge manually.
No model calls, transcript edits, or SQL writes.
"""
import argparse
import importlib.util
import json
from pathlib import Path
from urllib import parse

spec = importlib.util.spec_from_file_location('root_note_stop', Path(__file__).resolve().parents[1] / '.ygg/hooks/root_note_stop.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def recovery_target(rows, source_id, tip_id=None):
    by_id = {row['id']: row for row in rows}
    route = set()
    if tip_id:
        current_id = tip_id
        while current_id != source_id:
            if current_id in route or current_id not in by_id:
                raise ValueError('Writer tip does not descend from source')
            route.add(current_id)
            current_id = by_id[current_id].get('parent_id')
        if not route:
            raise ValueError('Writer tip must descend from source')
    source = by_id.get(source_id)
    if not source or not hook._is_scaffolding_message(source) or not source.get('note'):
        raise ValueError('Source must be a generated message with a saved note')
    if source.get('note') == '__auto_compaction_summary__':
        raise ValueError('Compaction markers are not branch notes')
    current = source
    seen = {source_id}
    while True:
        children = [row for row in rows if row.get('parent_id') == current['id'] and (not tip_id or row['id'] in route)]
        if len(children) != 1:
            raise ValueError('No unique descendant prompt; refusing to guess across a fork')
        current = children[0]
        if current['id'] in seen:
            raise ValueError('Cyclic ancestry')
        seen.add(current['id'])
        if hook._is_human_message(current):
            if current.get('note'):
                raise ValueError('Destination already has a note; no overwrite performed')
            return source, current
        if not hook._is_scaffolding_message(current):
            raise ValueError('Non-scaffolding turn before a human prompt; refusing to guess')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:3002/api')
    parser.add_argument('--conversation', required=True)
    parser.add_argument('--anchor', required=True)
    parser.add_argument('--writer-tip', help='Operator-verified last writer from hook logs; script checks ancestry only')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    base = args.base.rstrip('/')
    origin = parse.urlsplit(base)
    if origin.scheme != 'http' or origin.hostname not in ('127.0.0.1', 'localhost', '::1') or origin.username or origin.password:
        raise ValueError('Recovery requires a local HTTP callback endpoint')
    url = f'{base}/app/conversations/{parse.quote(args.conversation, safe="")}/messages'
    rows = hook._json_request(url)
    source, target = recovery_target(rows, args.anchor, args.writer_tip)
    if source.get('conversation_id') != args.conversation or target.get('conversation_id') != args.conversation:
        raise ValueError('Conversation identity mismatch')
    report = {'source': source['id'], 'target': target['id'], 'noteLength': len(source['note']), 'applied': False}
    if args.apply:
        # Revalidate just before writing; no source deletion, even after success.
        fresh_source, fresh_target = recovery_target(hook._json_request(url), args.anchor, args.writer_tip)
        if fresh_source != source or fresh_target != target:
            raise ValueError('Messages changed during recovery; retry after activity settles')
        payload = {'note': source['note']}
        if not target.get('note_color') and source.get('note_color'):
            payload['note_color'] = source['note_color']
        target_url = f'{base}/app/messages/{parse.quote(target["id"], safe="")}'
        hook._json_request(target_url, method='PUT', payload=payload)
        saved = hook._json_request(target_url)
        if any(saved.get(key) != value for key, value in payload.items()):
            raise ValueError('Saved note verification failed; source note is still intact')
        report['applied'] = True
    print(json.dumps(report))


if __name__ == '__main__':
    main()
