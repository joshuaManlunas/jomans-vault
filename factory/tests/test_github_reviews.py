from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from test_split import FAKE_GH as SPLIT_FAKE_GH


REPO = Path(__file__).resolve().parents[2]
HEAD = 'a' * 40
OLD_HEAD = 'b' * 40
CODEX = 'chatgpt-codex-connector'
GREPTILE = 'greptile-apps'

# Reuse the strict stateful fake from split tests; only these extra calls are allowed.
FAKE_GH = SPLIT_FAKE_GH.replace(
    '''elif args[:2] == ["pr", "view"]:
    print(json.dumps({"state": state.get("pr_state", "OPEN")}))''',
    '''elif args[0] == "api" and args[1].startswith("repos/test/repo/commits/") and args[1].endswith("/check-runs"):
    assert args[2:] == ["--paginate", "--slurp"]
    sha = args[1].split("/")[4]
    print(json.dumps([{"check_runs": state.get("check_runs", {}).get(sha, [])}]))
elif args[:2] == ["repo", "view"]:
    assert args == ["repo", "view", "--json", "nameWithOwner"]
    print(json.dumps({"nameWithOwner": "test/repo"}))
elif args[:2] == ["pr", "view"]:
    assert args[2:4] == ["99", "--json"]
    fields = {"state": state.get("pr_state", "OPEN"), "isDraft": state["draft"],
              "headRefOid": state.get("pr_head", state["head"])}
    assert all(f in fields for f in args[4].split(","))
    print(json.dumps({f: fields[f] for f in args[4].split(",")}))
elif args[:2] == ["pr", "ready"]:
    assert args == ["pr", "ready", "99"]
    state["draft"] = False
elif args[:2] == ["pr", "comment"]:
    assert args[:4] == ["pr", "comment", "99", "--body"] and len(args) == 5
    if args[4] == "@greptileai review" and state.get("reviews_on_trigger"):
        state["reviews"] = state["reviews_on_trigger"]
elif args[:2] == ["pr", "merge"]:
    assert args == ["pr", "merge", "99", "--merge"]
    state["pr_state"] = "MERGED"
elif args[:2] == ["api", "graphql"]:
    query = option("-f")
    assert query.startswith("query=")
    assert "owner=test" in args and "repo=repo" in args and "number=99" in args
    connection = next(c for c in ["reviewThreads", "reviews", "comments"] if c + "(first:" in query)
    if connection == "reviews" and os.environ.get("FAKE_REVIEWS_READY"):
        with open(os.environ["FAKE_REVIEWS_READY"], "w") as ready:
            ready.write("ready\\n")
    assert "pageInfo { hasNextPage endCursor }" in query
    assert "after: $cursor" in query
    pages = state.get(connection + "_pages", [state.get(connection, [])])
    cursor = next((a.split("=", 1)[1] for a in args if a.startswith("cursor=")), None)
    index = int(cursor) if cursor else 0
    node = {"nodes": pages[index], "pageInfo": {"hasNextPage": index + 1 < len(pages),
                                              "endCursor": str(index + 1)}}
    print(json.dumps({"data": {"repository": {"pullRequest": {connection: node}}}}))''').replace(
    'state_path.write_text(json.dumps(state))',
    'tmp_path = state_path.with_suffix(f".{os.getpid()}.tmp")\n'
    'tmp_path.write_text(json.dumps(state))\n'
    'tmp_path.replace(state_path)')

FAKE_GIT = '''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
path = Path(os.environ["FAKE_GH_STATE"])
state = json.loads(path.read_text())
with open(os.environ["FAKE_GIT_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args == ["rev-parse", "HEAD"]:
    print(Path(os.environ["FAKE_GIT_HEAD"]).read_text().strip()
          if os.environ.get("FAKE_GIT_HEAD") else state["head"])
elif args[:2] == ["merge-base", "--is-ancestor"]:
    assert args[2:] == ["b" * 40, "a" * 40]
    sys.exit(0 if state.get("review_is_ancestor", False) else 1)
elif args[:2] == ["rev-list", "--no-merges"]:
    assert args[2:] == ["b" * 40 + ".." + "a" * 40, "^origin/main"]
    print(state.get("unreviewed_commits", ""))
elif args == ["fetch", "origin", "main"]:
    pass
elif args == ["merge", "--no-edit", "origin/main"]:
    state["head"] = state.get("synced_head", state["head"])
elif args == ["push", "origin", "factory/001-reviews"]:
    state["pr_head"] = state["head"]
elif args == ["push", "origin", "--delete", "factory/001-reviews"]:
    pass
elif args[:3] == ["worktree", "remove", "--force"] or args == ["branch", "-D", "factory/001-reviews"]:
    pass
else:
    sys.exit("unexpected git call: " + repr(args))
path.write_text(json.dumps(state))
'''


def review(bot, sha=HEAD):
    return {'author': {'login': bot}, 'state': 'COMMENTED', 'commit': {'oid': sha}}


def state_comment(bot=CODEX, sha=HEAD, status='completed'):
    data = {'code_review': {'commit_sha': sha, 'status': status,
                           'has_any_findings': False, 'has_unresolved_findings': False},
            'nested': {'text': 'a } brace inside a string'}}
    return {'author': {'login': bot},
            'body': '<!-- codex-review-state:v1 ' + json.dumps(data) + ' -->\nOther text'}


def thread(resolved=False):
    return {'id': 'PRRT_thread1', 'isResolved': resolved, 'path': 'demo/greet.py', 'line': 12,
            'comments': {'nodes': [{'author': {'login': 'human-reviewer'},
                                    'body': 'Please fix this.\nSecond line.',
                                    'url': 'https://github.com/test/repo/pull/99#discussion_r1'}]}}



# The tests run against the installed project's config.json; pin the settings
# they depend on so a project's own base branch, merge method, bots or
# concurrency can't break them.
PINNED_CONFIG = {
    "forge": {"type": "github", "host": "github.com", "project": "test/repo"},
    "base_branch": "main", "merge_method": "merge", "concurrency": 3, "auto_split": False,
    "review_bots": {"bots": [{"login": "chatgpt-codex-connector", "trigger": "@codex review"},
                                {"login": "greptile-apps", "trigger": "@greptileai review"}],
                       "timeout_minutes": 20, "poll_seconds": 30},
}


def copy_config(src, dst):
    config = json.loads(Path(src).read_text())
    config.update(PINNED_CONFIG)
    Path(dst).write_text(json.dumps(config))

class GitHubReviewTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.factory = self.root / 'factory'
        (self.factory / 'bin').mkdir(parents=True)
        shutil.copy2(REPO / 'factory/bin/job', self.factory / 'bin/job')
        shutil.copy2(REPO / "factory/bin/forge", self.factory / "bin/forge")
        copy_config(REPO / 'factory/config.json', self.factory / 'config.json')
        gate = self.factory / 'bin/gate'
        gate.write_text('#!/bin/sh\nexit 0\n')
        gate.chmod(0o755)
        fake_bin = self.root / 'fake-bin'
        fake_bin.mkdir()
        for name, body in [('gh', FAKE_GH), ('git', FAKE_GIT)]:
            path = fake_bin / name
            path.write_text(body)
            path.chmod(0o755)
        self.state_path = self.root / 'gh-state.json'
        self.log_path = self.root / 'gh-log.jsonl'
        self.git_log = self.root / 'git-log.jsonl'
        self.state_path.write_text(json.dumps({
            'head': HEAD, 'draft': True, 'reviews': [review(GREPTILE)],
            'comments': [state_comment(CODEX + '[bot]')], 'reviewThreads': [],
            'issues': {'10': {'number': 10, 'title': 'Reviews', 'body': 'Request',
                              'author': {'login': 'author'}, 'labels': [{'name': 'factory'}],
                              'state': 'OPEN', 'url': 'https://github.com/test/repo/issues/10',
                              'comments': []}},
        }))
        self.env = {**os.environ, 'PATH': str(fake_bin) + os.pathsep + os.environ['PATH'],
                    'FAKE_GH_STATE': str(self.state_path), 'FAKE_GH_LOG': str(self.log_path),
                    'FAKE_GIT_LOG': str(self.git_log), 'CLAUDE_CONFIG_DIR': str(self.root / 'claude'),
                    'FACTORY_REVIEWS_POLL_SECONDS': '0', 'FACTORY_REVIEWS_TIMEOUT_SECONDS': '0'}
        self.job_id = self.job('create', '10').stdout.strip()
        self.job_dir = self.factory / 'jobs' / self.job_id
        self.rd = self.job_dir / 'round-1'
        self.rd.mkdir()
        self.update_job(stage='approve', round=1, pr=99, pr_url='https://github.com/test/repo/pull/99',
                        worktree=str(self.root), branch='factory/001-reviews')
        (self.job_dir / 'decision.md').write_text('APPROVE\n\nReady.\n')

    def job(self, *args, code=0):
        result = subprocess.run([sys.executable, str(self.factory / 'bin/job'), *args],
                                cwd=self.root, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def state(self, **changes):
        state = json.loads(self.state_path.read_text())
        state.update(changes)
        self.state_path.write_text(json.dumps(state))
        return state

    def read_job(self):
        return json.loads((self.job_dir / 'job.json').read_text())

    def update_job(self, **changes):
        job = self.read_job()
        job.update(changes)
        (self.job_dir / 'job.json').write_text(json.dumps(job))

    def calls(self, *prefix):
        calls = [json.loads(line) for line in self.log_path.read_text().splitlines()]
        return [call for call in calls if call[:len(prefix)] == list(prefix)]

    def config_bots(self, bots):
        path = self.factory / 'config.json'
        config = json.loads(path.read_text())
        config['review_bots']['bots'] = bots
        path.write_text(json.dumps(config))

    @contextmanager
    def waiting_reviews(self, *, seconds=3, code=3):
        self.state(reviews=[])
        self.env.update(FACTORY_REVIEWS_TIMEOUT_SECONDS=str(seconds),
                        FACTORY_REVIEWS_POLL_SECONDS='0.1')
        ready = self.root / 'reviews-ready'
        os.mkfifo(ready)
        self.env['FAKE_REVIEWS_READY'] = str(ready)
        fd = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        try:
            process = subprocess.Popen(
                [sys.executable, str(self.factory / 'bin/job'), 'reviews', '10'],
                cwd=self.root, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True)
            try:
                self.assertTrue(select.select([fd], [], [], 5)[0], 'reviews never started polling')
                os.read(fd, 4096)
                self.assertIsNone(process.poll())
                yield process
            finally:
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, code, stdout + stderr)
                if code == 1:
                    self.assertIn('changed while waiting for review bots', stderr)
                    self.assertIn('refusing to write review results', stderr)
        finally:
            os.close(fd)
            ready.unlink()

    def test_waiting_reviews_by_issue_does_not_lock_other_jobs_or_queue(self):
        other_id = '002-other'
        other_dir = self.factory / 'jobs' / other_id
        other_dir.mkdir()
        other = {**self.read_job(), 'id': other_id, 'issue': 11, 'pr': None}
        (other_dir / 'job.json').write_text(json.dumps(other))
        with self.waiting_reviews() as process:
            for args in [('sync', other_id), ('queue',)]:
                result = subprocess.run(
                    [sys.executable, str(self.factory / 'bin/job'), *args],
                    cwd=self.root, env=self.env, capture_output=True, text=True, timeout=0.7)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIsNone(process.poll(), 'reviews exited before concurrent access completed')

    def test_reviews_refuse_changed_job_or_head_without_writing_files(self):
        head_file = self.root / 'head'
        self.env['FAKE_GIT_HEAD'] = str(head_file)
        for changes in [{'stage': 'merging'}, {'round': 2}, {'pr': 100},
                        {'worktree': str(self.factory)}, {'head': OLD_HEAD}]:
            with self.subTest(changes=changes):
                self.update_job(stage='approve', round=1, pr=99, worktree=str(self.root))
                head_file.write_text(HEAD)
                report = self.rd / 'reviews.md'
                report.write_text('previous report\n')
                triggered = self.job_dir / 'reviews-triggered.json'
                triggered.write_text(json.dumps({GREPTILE: [OLD_HEAD]}))
                # A ping that was really sent is recorded at once (see the killed-run
                # test); what a refused run must not write is its verdict or the job.
                before = {report: report.read_bytes()}
                with self.waiting_reviews(seconds=0.5, code=1):
                    if 'head' in changes:
                        head_file.write_text(changes['head'])
                    else:
                        self.update_job(**changes)
                    before[self.job_dir / 'job.json'] = (self.job_dir / 'job.json').read_bytes()
                for path, contents in before.items():
                    self.assertEqual(path.read_bytes(), contents, str(path))
                self.assertFalse((self.job_dir / 'round-2').exists())

    def test_legacy_review_key_is_used_only_when_review_bots_is_absent(self):
        path = self.factory / 'config.json'
        config = json.loads(path.read_text())
        config['github_reviews'] = config.pop('review_bots')
        path.write_text(json.dumps(config))
        self.job('reviews', self.job_id)
        self.assertEqual(self.read_job()['reviews_gate'], 'PASS')
        config['github_reviews']['bots'] = [{'login': 'missing-bot', 'trigger': '@missing review'}]
        config['review_bots'] = {'bots': [], 'timeout_minutes': 0, 'poll_seconds': 0}
        path.write_text(json.dumps(config))
        self.job('reviews', self.job_id)
        self.assertEqual(self.calls('pr', 'comment'), [])

    def test_draft_ready_and_both_review_formats_pass_for_head(self):
        result = self.job('reviews', self.job_id)
        self.assertIn(f'REVIEWS: PASS ({self.job_id} round 1,', result.stdout)
        report = (self.rd / 'reviews.md').read_text()
        self.assertTrue(report.startswith(f'REVIEWS: PASS\nCOMMIT: {HEAD}\n\n## Summary\n'))
        self.assertIn(CODEX, report)
        self.assertIn(GREPTILE, report)
        self.assertIn('Unresolved threads: 0', report)
        self.assertEqual(len(self.calls('pr', 'ready')), 1)
        self.assertEqual(self.calls('pr', 'comment'), [])
        self.assertEqual(self.read_job()['reviews_gate'], 'PASS')
        self.job('advance', self.job_id, 'merging')
        self.assertEqual(self.read_job()['stage'], 'merging')

    def test_unresolved_thread_fails_merge_and_returns_builder_to_next_round(self):
        self.state(reviewThreads=[thread(), thread(resolved=True)])
        self.job('reviews', self.job_id, code=1)
        report = (self.rd / 'reviews.md').read_text()
        self.assertIn('REVIEWS: FAIL', report)
        self.assertIn('Unresolved threads: 1', report)
        self.assertIn('- demo/greet.py:12 by @human-reviewer — PRRT_thread1', report)
        self.assertIn('> Please fix this.\n> Second line.', report)
        self.assertIn('#discussion_r1', report)
        self.job('merge', self.job_id, code=1)
        self.assertEqual(self.calls('pr', 'merge'), [])
        self.job('advance', self.job_id, 'needs-human', code=1)
        self.job('advance', self.job_id, 'build')
        job = self.read_job()
        self.assertEqual((job['stage'], job['round'], job['reviews_gate']), ('build', 2, None))
        self.assertTrue((self.job_dir / 'round-2').is_dir())

    def test_trigger_once_per_bot_and_head_across_timeout_reruns_and_rounds(self):
        self.state(reviews=[])
        for _ in range(2):
            self.job('reviews', self.job_id, code=3)
        self.assertEqual([c[-1] for c in self.calls('pr', 'comment')], ['@greptileai review'])
        self.assertIn(f'Timeout: waiting for @{GREPTILE}', (self.rd / 'reviews.md').read_text())
        self.assertEqual(self.read_job()['reviews_gate'], 'TIMEOUT')
        self.update_job(round=2)
        self.job('reviews', self.job_id, code=3)
        self.assertEqual(len(self.calls('pr', 'comment')), 1)
        self.state(head=OLD_HEAD)
        self.job('reviews', self.job_id, code=3)
        self.assertEqual([c[-1] for c in self.calls('pr', 'comment')],
                         ['@greptileai review', '@codex review', '@greptileai review'])

    def test_ping_is_recorded_before_the_wait_so_a_killed_run_does_not_ping_again(self):
        self.state(reviews=[])
        env = {**self.env, 'FACTORY_REVIEWS_TIMEOUT_SECONDS': '30', 'FACTORY_REVIEWS_POLL_SECONDS': '0.1'}
        process = subprocess.Popen([sys.executable, str(self.factory / 'bin/job'), 'reviews', self.job_id],
                                   cwd=self.root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            # Kill only once the ping is saved, so the test can't race the save.
            saved = self.job_dir / 'reviews-triggered.json'
            while not (saved.exists() and HEAD in saved.read_text()) and time.monotonic() < deadline:
                time.sleep(0.05)
            pinged = [c[-1] for c in self.calls('pr', 'comment')]
            self.assertEqual(pinged, ['@greptileai review'])
            self.assertIsNone(process.poll(), 'reviews finished instead of waiting')
        finally:
            process.kill()
            process.wait()
        self.job('reviews', self.job_id, code=3)
        self.assertEqual([c[-1] for c in self.calls('pr', 'comment')], pinged)

    def test_stale_incomplete_invalid_or_other_author_reviews_do_not_count(self):
        self.config_bots([{'login': GREPTILE, 'trigger': '@greptileai review'}])
        cases = [([review(GREPTILE, OLD_HEAD)], []),
                 ([], [state_comment(GREPTILE, OLD_HEAD)]),
                 ([], [state_comment(GREPTILE, status='in_progress')]),
                 ([], [{'author': {'login': GREPTILE}, 'body': 'codex-review-state:v1 {invalid}'}]),
                 ([], [state_comment(CODEX)])]
        for reviews, comments in cases:
            with self.subTest(reviews=reviews, comments=comments):
                self.state(reviews=reviews, comments=comments)
                self.job('reviews', self.job_id, code=3)
                self.assertIn(f'waiting for @{GREPTILE}', (self.rd / 'reviews.md').read_text())
        self.state(reviews=[review(GREPTILE + '[bot]')], comments=[])
        self.job('reviews', self.job_id)
        self.assertEqual(len(self.calls('pr', 'comment')), 1)

    def test_a_bots_passing_check_run_on_head_counts_as_its_review(self):
        # Greptile with no findings posts only a check run, never a review or comment.
        self.config_bots([{'login': GREPTILE, 'trigger': '@greptileai review'}])
        def run(sha=HEAD, slug=GREPTILE, conclusion='success', status='completed'):
            return {sha: [{'app': {'slug': slug}, 'status': status, 'conclusion': conclusion}]}
        cases = [(run(), 0), (run(conclusion='neutral'), 0), (run(conclusion='failure'), 3),
                 (run(status='in_progress', conclusion=None), 3), (run(sha=OLD_HEAD), 3),
                 (run(slug='socket-security'), 3)]
        for check_runs, code in cases:
            with self.subTest(check_runs=check_runs):
                self.state(reviews=[], comments=[], check_runs=check_runs)
                self.job('reviews', self.job_id, code=code)

    def test_triggered_review_is_polled_until_head_is_complete(self):
        self.state(reviews=[], reviews_on_trigger=[review(GREPTILE)])
        self.env['FACTORY_REVIEWS_TIMEOUT_SECONDS'] = '10'
        self.job('reviews', self.job_id)
        self.assertEqual([c[-1] for c in self.calls('pr', 'comment')], ['@greptileai review'])
        queries = [c[c.index('-f') + 1] for c in self.calls('api', 'graphql')]
        self.assertEqual(sum('reviews(first:' in q for q in queries), 2)

    def test_empty_bots_still_checks_all_pages_of_threads(self):
        self.config_bots([])
        self.state(reviewThreads_pages=[[thread(resolved=True)], [thread()]])
        self.job('reviews', self.job_id, code=1)
        queries = [c[c.index('-f') + 1] for c in self.calls('api', 'graphql')]
        self.assertTrue(all('reviewThreads(first:' in q for q in queries))
        self.assertEqual(len(queries), 2)
        self.assertEqual(self.calls('pr', 'comment'), [])
        self.state(reviewThreads_pages=[[]])
        self.job('reviews', self.job_id)

    def test_reviews_and_comments_paginate_before_deciding_to_trigger(self):
        self.state(reviews_pages=[[], [review(GREPTILE)]],
                   comments_pages=[[], [state_comment()]])
        self.job('reviews', self.job_id)
        self.assertEqual(self.calls('pr', 'comment'), [])

    def test_last_round_fail_and_timeout_escalate_with_reviews_file_reason(self):
        for verdict, code in [('FAIL', 1), ('TIMEOUT', 3)]:
            with self.subTest(verdict=verdict):
                self.update_job(stage='approve', round_limit=1)
                self.state(reviews=[review(GREPTILE)] if verdict == 'FAIL' else [],
                           reviewThreads=[thread()] if verdict == 'FAIL' else [])
                self.job('reviews', self.job_id, code=code)
                self.job('advance', self.job_id, 'build', code=1)
                self.job('advance', self.job_id, 'needs-human')
                self.assertEqual(self.read_job()['stage'], 'needs-human')
                reason = (self.job_dir / 'decision.md').read_text()
                self.assertIn(f'review bots {verdict}', reason)
                self.assertIn('round-1/reviews.md', reason)

    def test_missing_or_stale_pass_cannot_merge_or_advance_to_merging(self):
        for report in [None, f'REVIEWS: PASS\nCOMMIT: {OLD_HEAD}\n',
                       f'REVIEWS: FAIL\nCOMMIT: {OLD_HEAD}\n']:
            with self.subTest(report=report):
                if report:
                    (self.rd / 'reviews.md').write_text(report)
                for args in [('merge', self.job_id), ('advance', self.job_id, 'merging')]:
                    self.job(*args, code=1)
                self.assertEqual(self.read_job()['stage'], 'approve')
                self.assertEqual(self.calls('pr', 'merge'), [])
                self.job('advance', self.job_id, 'build', code=1)

    def test_merge_backstop_escalates_if_a_thread_became_unresolved(self):
        self.job('reviews', self.job_id)
        self.state(reviewThreads=[thread()])
        self.job('merge', self.job_id)
        self.assertEqual(self.calls('pr', 'merge'), [])
        self.assertEqual(self.read_job()['stage'], 'needs-human')
        self.assertIn('threads became unresolved', (self.job_dir / 'decision.md').read_text())
        self.assertTrue(self.git_log.exists())

    def test_merge_after_base_sync_keeps_the_reviewed_pass(self):
        # Syncing with a base that moved adds a merge commit; escalating on it
        # would send every parallel job to a human.
        self.job('reviews', self.job_id)
        self.state(synced_head=OLD_HEAD)
        self.job('merge', self.job_id)
        self.assertEqual(len(self.calls('pr', 'merge')), 1)
        self.assertEqual(self.read_job()['stage'], 'merged')

    def test_merge_accepts_only_base_sync_descendants_of_reviewed_commit(self):
        for stage in ['approve', 'merging']:
            for ancestor, commits, covered in [(True, '', True),
                                               (True, 'c' * 40, False),
                                               (False, '', False)]:
                with self.subTest(stage=stage, ancestor=ancestor, commits=commits):
                    self.update_job(stage=stage)
                    self.state(head=HEAD, review_is_ancestor=ancestor,
                               unreviewed_commits=commits, pr_state='OPEN', draft=False)
                    (self.rd / 'reviews.md').write_text(f'REVIEWS: PASS\nCOMMIT: {OLD_HEAD}\n')
                    before = len(self.calls('pr', 'merge'))
                    result = self.job('merge', self.job_id, code=0 if covered else 1)
                    self.assertEqual(len(self.calls('pr', 'merge')), before + int(covered))
                    self.assertEqual(self.read_job()['stage'], 'merged' if covered else stage)
                    if not covered:
                        self.assertIn('reviewed commit no longer covers HEAD', result.stderr)
                        if stage == 'approve':
                            self.assertIn('run review bots again', result.stderr)
                        else:
                            self.assertIn('needs a human', result.stderr)
                            self.assertNotIn('run review bots again', result.stderr)

    def test_reviews_require_approve_and_matching_pushed_head(self):
        self.update_job(stage='review')
        self.job('reviews', self.job_id, code=1)
        self.assertEqual(self.calls('pr', 'ready'), [])
        self.update_job(stage='approve')
        self.state(pr_head=OLD_HEAD)
        self.job('reviews', self.job_id, code=1)
        self.assertEqual(self.calls('pr', 'ready'), [])

    def test_sync_gives_legacy_jobs_null_and_reads_current_round_only(self):
        legacy = self.read_job()
        legacy.pop('reviews_gate')
        (self.job_dir / 'job.json').write_text(json.dumps(legacy))
        self.job('sync', self.job_id)
        self.assertIsNone(self.read_job()['reviews_gate'])
        (self.rd / 'reviews.md').write_text(f'REVIEWS: TIMEOUT\nCOMMIT: {HEAD}\n')
        self.job('sync', self.job_id)
        self.assertEqual(self.read_job()['reviews_gate'], 'TIMEOUT')
        self.update_job(round=2)
        self.job('sync', self.job_id)
        self.assertIsNone(self.read_job()['reviews_gate'])


if __name__ == '__main__':
    unittest.main()
