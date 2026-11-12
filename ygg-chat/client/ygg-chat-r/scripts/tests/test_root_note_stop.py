"""Run: python3 -B -m unittest discover -s scripts/tests -p 'test_root_note_stop.py'."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch
from urllib import error

spec = importlib.util.spec_from_file_location('root_note_stop', Path(__file__).resolve().parents[2] / '.ygg/hooks/root_note_stop.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class HookDiagnosticsTest(unittest.TestCase):
    def run_main(self, responses):
        payload = {'hook_event_name': 'Stop', 'conversation_id': 'conversation', 'message_id': 'branch',
                   'lookup': {'local_api_base': 'http://localhost:3002/api'}, 'turn': {'last_user_message_id': 'branch'}}
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(hook.sys, 'stdin', io.StringIO(json.dumps(payload))), patch.object(hook, '_json_request', side_effect=responses), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                hook.main()
                exit_code = 0
            except SystemExit as exc:
                exit_code = exc.code
        return exit_code, json.loads(stdout.getvalue()), stderr.getvalue()

    @staticmethod
    def branches():
        return [{'id': 'branch', 'role': 'user', 'parent_id': None, 'content': 'private user content'},
                {'id': 'other', 'role': 'user', 'parent_id': None, 'content': 'other branch'}]

    def test_http_failure_keeps_status_path_and_sanitized_server_error(self):
        body = json.dumps({'error': {'message': 'Expired token=topsecret Bearer abc.def private user content'}}).encode()
        exc = error.HTTPError('http://localhost/api/headless/ygg-hooks/generate?secret=hidden', 401, 'Unauthorized', {}, io.BytesIO(body))
        with patch.object(hook.request, 'urlopen', side_effect=exc), self.assertRaises(hook.HookFailure) as raised:
            hook._json_request(exc.url, method='POST', stage='generate_note', sensitive=('private user content',))
        failure = raised.exception
        self.assertEqual(failure.code, 'http_error')
        self.assertEqual(failure.details['httpStatus'], 401)
        self.assertEqual(failure.details['path'], '/api/headless/ygg-hooks/generate')
        self.assertGreaterEqual(failure.details['elapsedMs'], 0)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            hook._emit_failure(failure, 'outer_stage', time.monotonic())
        combined = out.getvalue() + err.getvalue()
        for secret in ('topsecret', 'abc.def', 'private user content', '?secret=hidden'):
            self.assertNotIn(secret, combined)
        self.assertIn('generate_note: HTTP 401', combined)
        self.assertEqual(json.loads(out.getvalue())['diagnostic']['exceptionTypes'], ['HookFailure', 'HTTPError'])

    def test_non_json_and_oversized_error_bodies_are_not_logged(self):
        for body in (b'<html>private content</html>', b'x' * 5000):
            exc = error.HTTPError('http://localhost/api', 502, 'Bad gateway', {}, io.BytesIO(body))
            with patch.object(hook.request, 'urlopen', side_effect=exc), self.assertRaises(hook.HookFailure) as raised:
                hook._json_request(exc.url)
            self.assertNotIn('serverError', raised.exception.details)

    def test_timeout_and_connection_refusal_are_distinct(self):
        for reason, code in ((TimeoutError('timed out'), 'request_timeout'), (ConnectionRefusedError(61, 'Connection refused'), 'connection_error')):
            with patch.object(hook.request, 'urlopen', side_effect=error.URLError(reason)), self.assertRaises(hook.HookFailure) as raised:
                hook._json_request('http://localhost/api', stage='fetch_messages')
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(raised.exception.details['timeoutSeconds'], 20)
            self.assertEqual(raised.exception.details['reasonType'], type(reason).__name__)

    def test_malformed_response_does_not_log_body(self):
        response = io.BytesIO(b'private content, not JSON')
        response.status = 200
        with patch.object(hook.request, 'urlopen', return_value=response), self.assertRaises(hook.HookFailure) as raised:
            hook._json_request('http://localhost/api')
        self.assertEqual(raised.exception.code, 'invalid_response_json')
        self.assertEqual(raised.exception.details['jsonLine'], 1)
        self.assertNotIn('private content', str(raised.exception.details))

    def test_generation_shape_and_model_json_failures(self):
        for response, code in (([], 'invalid_response_shape'), ({'text': 'private non-JSON model output'}, 'invalid_model_json')):
            exit_code, result, stderr = self.run_main([self.branches(), response, response])
            self.assertEqual(exit_code, 1)
            self.assertEqual(result['outcomeCode'], code)
            self.assertEqual(result['diagnostic']['stage'], 'parse_generation')
            self.assertNotIn('private', json.dumps(result) + stderr)

    def test_fetch_shape_failure_is_not_reported_as_skip(self):
        exit_code, result, _ = self.run_main([{'error': 'unexpected'}])
        self.assertEqual(exit_code, 1)
        self.assertEqual(result['outcomeCode'], 'invalid_response_shape')
        self.assertEqual(result['diagnostic']['stage'], 'fetch_messages')

    def test_hydration_failure_preserves_original_stage(self):
        failure = hook.HookFailure('http_error', 'hydrate_message', 'HTTP 404', httpStatus=404)
        exit_code, result, _ = self.run_main([[{'id': 'other', 'parent_id': None}], failure])
        self.assertEqual(exit_code, 1)
        self.assertEqual(result['diagnostic']['stage'], 'hydrate_message')
        self.assertEqual(result['diagnostic']['httpStatus'], 404)

    def test_unexpected_failure_has_location_without_private_exception_text(self):
        exit_code, result, stderr = self.run_main([ValueError('private user content')])
        self.assertEqual(exit_code, 1)
        self.assertEqual(result['outcomeCode'], 'unexpected_error')
        self.assertIn('location', result['diagnostic'])
        self.assertIn('ValueError', stderr)
        self.assertNotIn('private user content', json.dumps(result) + stderr)

    def test_save_failure_is_specific(self):
        failure = hook.HookFailure('http_error', 'save_note', 'HTTP 500', httpStatus=500)
        exit_code, result, _ = self.run_main([self.branches(), {'text': json.dumps({'updated': True, 'note': 'new note'})}, failure])
        self.assertEqual(exit_code, 1)
        self.assertEqual(result['diagnostic']['stage'], 'save_note')

    def test_success_and_skip_contract_remain_unchanged(self):
        exit_code, result, stderr = self.run_main([self.branches(), {'text': json.dumps({'updated': True, 'note': 'new note'})}, {}])
        self.assertEqual((exit_code, result['outcomeCode'], stderr), (0, 'updated', ''))
        exit_code, result, stderr = self.run_main([[]])
        self.assertEqual((exit_code, result['outcomeCode'], stderr), (0, 'messages_unavailable', ''))

    def test_redaction_covers_quoted_secrets_urls_and_known_content(self):
        detail = hook._safe_error_detail('password="two word secret" https://user:pass@host/path?token=abc sk-privatekey note text', ('note text',))
        for secret in ('two word secret', 'user:pass', 'token=abc', 'sk-privatekey', 'note text'):
            self.assertNotIn(secret, detail)
        self.assertLessEqual(len(hook._safe_error_detail('x' * 1000)), 400)


class BranchAnchorTest(unittest.TestCase):
    @staticmethod
    def row(id, parent=None, kind=None, role='user', **fields):
        return dict(id=id, parent_id=parent, role=role, content=id,
                    meta=json.dumps({'kind': kind}) if kind else None, **fields)

    def anchor(self, rows, tip):
        by_id = {row['id']: row for row in rows}
        chain, seen = [], set()
        while tip in by_id and tip not in seen:
            seen.add(tip)
            chain.append(by_id[tip])
            tip = by_id[tip]['parent_id']
        result = hook._find_branch_anchor(rows, chain)
        return result['id'] if result else None

    def test_injected_prefix_at_nested_fork_targets_human_not_reminder(self):
        r = self.row
        rows = [r('root'), r('reply', 'root', role='assistant'), r('other', 'reply'),
                r('prefix', 'reply', 'context_injection'), r('mode', 'prefix', 'operation_mode_change'),
                r('human', 'mode'), r('answer', 'human', role='assistant'), r('followup', 'answer')]
        self.assertEqual(self.anchor(rows, 'followup'), 'human')

    def test_root_branches_with_separate_and_shared_prefixes(self):
        r = self.row
        for rows in ([r('prefix', kind='context_injection'), r('human', 'prefix'), r('other')],
                     [r('prefix', kind='context_injection'), r('human', 'prefix'), r('other', 'prefix')],
                     [r('prefix', kind='context_injection'), r('human', 'prefix'),
                      r('prefix2', kind='context_injection'), r('other', 'prefix2')]):
            with self.subTest(rows=rows):
                self.assertEqual(self.anchor(rows, 'human'), 'human')
                self.assertEqual(self.anchor(rows, 'other'), 'other')

    def test_linear_branch_and_dangling_generated_sibling_do_not_create_note(self):
        r = self.row
        rows = [r('prefix', kind='context_injection'), r('human', 'prefix'),
                r('answer', 'human', role='assistant'), r('followup', 'answer')]
        self.assertIsNone(self.anchor(rows, 'followup'))
        rows.append(r('unused', kind='context_injection'))
        self.assertIsNone(self.anchor(rows, 'followup'))

    def test_nearest_nested_fork_and_route_isolation(self):
        r = self.row
        rows = [r('root'), r('other'), r('answer', 'root', role='assistant'),
                r('prefixA', 'answer', 'context_injection'), r('a', 'prefixA'),
                r('prefixB', 'answer', 'context_injection'), r('b', 'prefixB')]
        self.assertEqual(self.anchor(rows, 'a'), 'a')
        self.assertEqual(self.anchor(rows, 'b'), 'b')

    def test_generated_rows_cannot_own_notes_but_human_quotes_and_blocks_can(self):
        for kind in ('context_injection', 'operation_mode_change', 'full_access_change',
                     'watcher_completion', 'compaction_instruction', 'compaction_resume', 'compaction_summary'):
            for meta in ({'kind': kind}, json.dumps({'kind': kind})):
                row = self.row('generated')
                row['meta'] = meta
                self.assertFalse(hook._is_human_message(row))
        for meta in (None, '', '{broken', '[]', [], {'kind': 'ordinary'}):
            row = self.row('human')
            row.update(meta=meta, content='<system-reminder>quoted by a human</system-reminder>',
                       content_blocks=[{'type': 'context_injection'}])
            self.assertTrue(hook._is_human_message(row))

    def test_generated_tip_does_not_choose_a_sibling_or_later_prompt(self):
        r = self.row
        rows = [r('prefix', kind='context_injection'), r('human', 'prefix'), r('other')]
        self.assertIsNone(self.anchor(rows, 'prefix'))

    def test_cycle_and_missing_parent_fail_closed(self):
        r = self.row
        self.assertIsNone(self.anchor([r('human', 'prefix'), r('prefix', 'human', 'context_injection')], 'human'))
        self.assertIsNone(self.anchor([r('human', 'missing'), r('other', 'missing')], 'human'))

    def test_main_puts_note_on_human_prompt_and_preserves_color(self):
        r = self.row
        rows = [r('prefix', kind='context_injection', note='hidden old note'),
                r('branch', 'prefix', note='existing human note', note_color='#ef4444'), r('other')]
        payload = {'hook_event_name': 'Stop', 'conversation_id': 'conversation', 'message_id': 'branch',
                   'lookup': {'local_api_base': 'http://localhost:3002/api'}, 'turn': {'last_user_message_id': 'branch'}}
        output = io.StringIO()
        with patch.object(hook.sys, 'stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(output), patch.object(
            hook, '_json_request', side_effect=[rows, {'text': json.dumps({'updated': True, 'note': 'updated human note', 'note_color': '#22c55e'})}, {}]
        ) as request:
            hook.main()
        self.assertEqual(request.call_args.args[0], 'http://localhost:3002/api/app/messages/branch')
        self.assertEqual(request.call_args.kwargs['payload'], {'note': 'updated human note'})
        model_input = request.call_args_list[1].kwargs['payload']['content']
        self.assertIn('Existing branch note:\nexisting human note', model_input)
        self.assertNotIn('hidden old note', model_input)
        self.assertEqual(json.loads(output.getvalue())['outcomeCode'], 'updated')


if __name__ == '__main__':
    unittest.main()
