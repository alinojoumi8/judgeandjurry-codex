"""Offline checks for provider usage accounting, including missing-usage errors."""
import importlib.util
import json
import hashlib
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'scripts/minimax_usage_audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class MiniMaxUsageAuditTests(unittest.TestCase):
    def test_recovers_usage_from_hash_verified_pending_metadata_commit(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            request = b'{"model":"fixture","messages":[]}'
            response = b'{"model":"fixture","usage":{"total_tokens":19,"prompt_tokens":15,"completion_tokens":4}}'
            data = dict(startedAt='2026-10-14T00:00:00Z', state='receiving', httpStatus=200,
                        requestHash=hashlib.sha256(request).hexdigest())
            (root / 'request-body.txt').write_bytes(request)
            (root / 'response-body.raw').write_bytes(response)
            (root / 'exchange.json').write_text(json.dumps(data), encoding='utf-8')
            pending = dict(data, state='received', responseHash=hashlib.sha256(response).hexdigest(),
                           reportedUsage=json.loads(response)['usage'])
            (root / 'exchange.json.writing').write_text(json.dumps(pending), encoding='utf-8')
            result = audit.read_exchange(root / 'exchange.json', root)
            self.assertEqual(result['usage']['total_tokens'], 19)
            self.assertTrue(result['recoveredFromPendingMetadataCommit'])
            self.assertEqual(audit.aggregate([result])['calls'], 1)
            self.assertEqual(json.loads((root / 'exchange.json').read_text())['state'], 'receiving')
            pending['responseHash'] = 'wrong'
            (root / 'exchange.json.writing').write_text(json.dumps(pending), encoding='utf-8')
            rejected = audit.read_exchange(root / 'exchange.json', root)
            self.assertIsNone(rejected['usage'])
            self.assertFalse(rejected.get('recoveredFromPendingMetadataCommit', False))

    def row(self, usage=None, **fields):
        return dict(startedAt='2026-10-14T00:00:00Z', run='example', requestHash='same',
                    requestRole='checker', httpStatus=200, usage=usage, **fields)

    def test_cache_and_reasoning_are_not_double_counted(self):
        result = audit.aggregate([self.row({'total_tokens': 120, 'prompt_tokens': 100, 'completion_tokens': 20,
                                          'prompt_tokens_details': {'cached_tokens': 80},
                                          'completion_tokens_details': {'reasoning_tokens': 15}})])
        self.assertEqual(result['reportedTotalTokens'], 120)
        self.assertEqual(result['uncachedInputTokens'], 20)
        self.assertEqual(result['reasoningOutputTokens'], 15)

    def test_missing_usage_is_unknown(self):
        result = audit.aggregate([self.row()])
        self.assertEqual(result['calls'], 1)
        self.assertEqual(result['callsWithoutReportedUsage'], 1)
        self.assertIsNone(result['actualCost'])

    def test_repeated_actual_dispatches_count_but_cumulative_snapshots_do_not(self):
        result = audit.report([self.row({'total_tokens': 120}), self.row({'total_tokens': 130})], 0)
        self.assertEqual(result['totals']['calls'], 2)
        self.assertEqual(result['totals']['reportedTotalTokens'], 250)
        self.assertEqual(result['exactRepeatedRequestsBeyondFirst']['calls'], 1)
        self.assertEqual(result['exactRepeatedRequestsBeyondFirst']['reportedTotalTokens'], 130)

    def test_time_window_excludes_outside_calls(self):
        result = audit.report([self.row({'total_tokens': 120})], audit.epoch('2026-10-14T00:01:00Z'))
        self.assertEqual(result['totals'].get('calls', 0), 0)

    def test_absent_cache_details_are_not_treated_as_zero_cache(self):
        result = audit.aggregate([self.row({'total_tokens': 120, 'prompt_tokens': 100, 'completion_tokens': 20})])
        self.assertIsNone(result['uncachedInputTokens'])

    def test_prepared_files_are_not_counted_as_dispatched_calls(self):
        result = audit.aggregate([self.row(state='prepared')])
        self.assertEqual(result.get('calls', 0), 0)
        self.assertEqual(result['preparedNotDispatched'], 1)

    def test_recent_focused_and_visible_browser_runs_are_discovered(self):
        with TemporaryDirectory() as directory:
            project = Path(directory)
            focused = project / 'tmp/qa/courtroom/jury-v161-focused/live-hash-1791952000000'
            browser = project / 'tmp/qa/courtroom/browser-v161-1791952000000'
            old = project / 'tmp/qa/courtroom/jury-v161-focused/live-hash-1791900000000'
            for root in (focused, browser, old):
                root.mkdir(parents=True)
            self.assertEqual(set(audit.discover(project, 1791950000)), {focused, browser})

    def test_recent_fresh_followup_is_discovered_without_frozen_copies(self):
        with TemporaryDirectory() as directory:
            project = Path(directory)
            recent = project / 'tmp/qa/courtroom/jury-v198-fresh-followup/live-hash-1791952000000'
            old = project / 'tmp/qa/courtroom/jury-v198-fresh-followup/live-hash-1791900000000'
            frozen = project / 'tmp/qa/jury-v198-fresh-followup-frozen/tmp/qa/courtroom/jury-v198-fresh-followup/live-hash-1791952000000'
            prepared = project / 'tmp/qa/courtroom/jury-v198-fresh-followup/prepared-1791952000000'
            for root in (recent, old, frozen, prepared):
                root.mkdir(parents=True)
            self.assertEqual(set(audit.discover(project, 1791950000)), {recent})


if __name__ == '__main__':
    unittest.main()
