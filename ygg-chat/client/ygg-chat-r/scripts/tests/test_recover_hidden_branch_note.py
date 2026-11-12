import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('recover', Path(__file__).resolve().parents[1] / 'recover_hidden_branch_note.py')
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)


class RecoveryTest(unittest.TestCase):
    def rows(self):
        return [
            {'id': 'prefix', 'parent_id': None, 'role': 'user', 'meta': '{"kind":"context_injection"}', 'note': 'saved', 'note_color': '#ef4444'},
            {'id': 'mode', 'parent_id': 'prefix', 'role': 'user', 'meta': {'kind': 'operation_mode_change'}},
            {'id': 'human', 'parent_id': 'mode', 'role': 'user'},
            {'id': 'answer', 'parent_id': 'human', 'role': 'assistant'},
        ]

    def test_unique_prompt_through_scaffolding_without_mutating_rows(self):
        rows = self.rows()
        source, target = recover.recovery_target(rows, 'prefix')
        self.assertEqual(target['id'], 'human')
        self.assertEqual(source['note'], 'saved')
        self.assertNotIn('note', target)

    def test_fork_requires_verified_writer_ancestry(self):
        rows = self.rows() + [{'id': 'sibling', 'parent_id': 'prefix', 'role': 'user'}]
        with self.assertRaisesRegex(ValueError, 'unique'):
            recover.recovery_target(rows, 'prefix')
        self.assertEqual(recover.recovery_target(rows, 'prefix', 'answer')[1]['id'], 'human')
        with self.assertRaisesRegex(ValueError, 'descend'):
            recover.recovery_target(rows, 'prefix', 'foreign')

    def test_existing_note_never_overwritten(self):
        rows = self.rows()
        rows[2]['note'] = 'human edited'
        with self.assertRaisesRegex(ValueError, 'already has'):
            recover.recovery_target(rows, 'prefix')

    def test_never_crosses_ordinary_assistant_or_recovers_compaction_marker(self):
        rows = self.rows()
        rows[1].update(role='assistant', meta=None)
        with self.assertRaisesRegex(ValueError, 'Non-scaffolding'):
            recover.recovery_target(rows, 'prefix')
        rows = self.rows()
        rows[0]['note'] = '__auto_compaction_summary__'
        with self.assertRaisesRegex(ValueError, 'markers'):
            recover.recovery_target(rows, 'prefix')


if __name__ == '__main__':
    unittest.main()
