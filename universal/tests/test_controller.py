import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from pc_control import Controller, Rejected, checked_path, validate


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.controller = Controller(Path(self.temp.name) / 'state')
        self.target = Path(self.temp.name) / 'fixture.txt'

    def tearDown(self):
        self.controller.store.close()
        self.temp.cleanup()

    def request(self, text='one\n', **extra):
        return {'action': 'file.write', 'request_id': 'file-write-test-001',
                'params': {'path': str(self.target), 'text': text, 'mode': 'append', **extra}}

    def test_duplicate_append_happens_once(self):
        request = self.request()
        self.assertTrue(self.controller.execute(request)['ok'])
        self.assertTrue(self.controller.execute(request)['duplicate'])
        self.assertEqual(self.target.read_text(), 'one\n')

    def test_unknown_is_never_replayed(self):
        request = self.request()
        self.controller.store.start(request)
        self.assertEqual(self.controller.execute(request)['status'], 'needs_reconciliation')
        self.assertFalse(self.target.exists())

    def test_reused_id_different_payload_rejected(self):
        self.controller.execute(self.request())
        with self.assertRaisesRegex(ValueError, 'REQUEST_ID_CONFLICT'):
            self.controller.execute(self.request('different'))
        self.assertEqual(self.target.read_text(), 'one\n')

    def test_existing_file_requires_hash(self):
        self.target.write_text('existing', encoding='utf-8')
        result = self.controller.execute(self.request())
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 'rejected')
        self.assertEqual(self.target.read_text(), 'existing')

    def test_matching_hash_allows_append(self):
        self.target.write_bytes(b'old')
        request = self.request('new', expected_sha256=hashlib.sha256(b'old').hexdigest())
        self.assertTrue(self.controller.execute(request)['ok'])
        self.assertEqual(self.target.read_bytes(), b'oldnew')

    def test_pause_blocks_mutations_but_keeps_health(self):
        (self.controller.state / 'PAUSED').write_text('owner')
        with self.assertRaisesRegex(Rejected, 'PAUSED'):
            self.controller.execute(self.request())
        self.assertTrue(self.controller.execute({'action': 'pc.health'})['data']['paused'])

    def test_protected_path_is_rejected_without_access(self):
        for path in ('E:\\manhwa', 'E:\\manhwa\\a.txt', 'E:/manhwa/../manhwa/a.txt'):
            with self.assertRaisesRegex(Rejected, 'PROTECTED'):
                checked_path(path)

    def test_missing_stable_id_is_rejected(self):
        with self.assertRaisesRegex(Rejected, 'STABLE_REQUEST_ID'):
            validate({'action': 'ui.invoke', 'params': {}})

    def test_unknown_fields_and_actions_are_rejected(self):
        for request in ({'action': 'pc.health', 'extra': True}, {'action': 'erase.everything'}):
            with self.assertRaises(Rejected):
                validate(request)

    def test_snapshot_required_before_ui_mutation(self):
        result = self.controller.execute({'action': 'ui.invoke', 'request_id': 'invoke-test-001', 'params': {'index': 0}})
        self.assertEqual(result['status'], 'rejected')
        self.assertIn('SNAPSHOT_REQUIRED', result['error'])

    def test_post_dispatch_exception_stays_unknown(self):
        def broken(action, params, request):
            return self.controller.effect(lambda: (_ for _ in ()).throw(RuntimeError('crash')))
        self.controller.dispatch = broken
        result = self.controller.execute(self.request())
        self.assertEqual(result['status'], 'needs_reconciliation')
        self.assertEqual(self.controller.store.lookup(self.request()['request_id'])['state'], 'unknown')
        self.assertEqual(self.controller.execute(self.request())['status'], 'needs_reconciliation')

    def test_durable_duplicate_after_controller_restart(self):
        self.controller.execute(self.request())
        self.controller.store.close()
        self.controller = Controller(Path(self.temp.name) / 'state')
        self.assertTrue(self.controller.execute(self.request())['duplicate'])
        self.assertEqual(self.target.read_text(), 'one\n')

    def test_unicode_and_literal_keys_are_preserved(self):
        text = 'Привет {Enter} 😀\nвторая строка'
        self.controller.execute(self.request(text))
        self.assertEqual(self.target.read_text(encoding='utf-8'), text)


if __name__ == '__main__':
    unittest.main()
