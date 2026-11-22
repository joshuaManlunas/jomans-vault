import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_github_reviews import FAKE_GH, REPO, copy_config, thread


class BotFixRoundTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.factory = self.root / "factory"
        (self.factory / "bin").mkdir(parents=True)
        for name in ("job", "forge", "gate"):
            shutil.copy2(REPO / "factory/bin" / name, self.factory / "bin" / name)
        config_path = self.factory / "config.json"
        copy_config(REPO / "factory/config.json", config_path)
        config = json.loads(config_path.read_text())
        config_path.write_text(json.dumps({**config, "max_rounds": 3}))
        self.checks = self.factory / "checks.sh"
        self.checks.write_text("exit 0\n")

        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        gh = fake_bin / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.state_path = self.root / "gh-state.json"
        self.env = {**os.environ, "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                    "FAKE_GH_STATE": str(self.state_path),
                    "FAKE_GH_LOG": str(self.root / "gh-log.jsonl"),
                    "CLAUDE_CONFIG_DIR": str(self.root / "claude")}
        self.state_path.write_text(json.dumps({
            "issues": {"10": {"number": 10, "title": "Bot fixes", "body": "Request",
                              "author": {"login": "author"}, "labels": [{"name": config["labels"]["queue"]}],
                              "state": "OPEN", "url": "https://github.com/test/repo/issues/10", "comments": []}},
            "draft": False, "reviewThreads": [],
        }))

        self.git("init", "-b", "main")
        self.git("config", "user.name", "Factory Test")
        self.git("config", "user.email", "factory@example.test")
        self.git("config", "commit.gpgsign", "false")
        self.git("commit", "--allow-empty", "-m", "Base")
        self.git("init", "--bare", "origin.git")
        self.git("remote", "add", "origin", str(self.root / "origin.git"))
        self.git("push", "origin", "main")
        self.job_id = self.command("job", "create", "10").strip()
        self.job_dir = self.factory / "jobs" / self.job_id
        self.job_path = self.job_dir / "job.json"
        job = self.read_job()
        self.branch = job["branch"]
        self.worktree = Path(job["worktree"])
        self.worktree.parent.mkdir()
        self.git("worktree", "add", "-b", self.branch, str(self.worktree), "origin/main")
        self.job_path.write_text(json.dumps({**job, "stage": "spec", "pr": 99,
                                            "agents": {"reviewers": {"code": {}}}}))
        (self.job_dir / "spec.md").write_text("# Spec\n")
        self.advance("build")
        self.push_commit("Initial build")

    def run_command(self, args, cwd, code=0):
        result = subprocess.run(args, cwd=cwd, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def git(self, *args, cwd=None):
        return self.run_command(["git", *args], cwd or self.root)

    def command(self, name, *args, code=0):
        return self.run_command([str(self.factory / "bin" / name), *args], self.root, code)

    def read_job(self):
        return json.loads(self.job_path.read_text())

    def round_dir(self, n):
        return self.job_dir / f"round-{n}"

    def advance(self, stage, code=0):
        return self.command("job", "advance", self.job_id, stage, code=code)

    def push_commit(self, message):
        self.git("commit", "--allow-empty", "-m", message, cwd=self.worktree)
        self.git("push", "origin", self.branch, cwd=self.worktree)
        self.head = self.git("rev-parse", "HEAD", cwd=self.worktree).strip()
        self.update_forge(head=self.head)
        (self.job_dir / "build.md").write_text("STATUS: READY\n")

    def update_forge(self, **changes):
        state = json.loads(self.state_path.read_text())
        self.state_path.write_text(json.dumps({**state, **changes}))

    def start_bot_fix(self):
        self.advance("gate")
        self.command("gate", self.job_id)
        self.advance("review")
        (self.round_dir(1) / "review-code.md").write_text("VERDICT: PASS\n")
        self.advance("approve")
        self.update_forge(reviewThreads=[thread()])
        (self.round_dir(1) / "reviews.md").write_text(f"REVIEWS: FAIL\nCOMMIT: {self.head}\n")
        self.advance("build")
        self.push_commit("Fix bot review thread")
        self.advance("gate")

    def test_bot_fix_round_approves_after_gate_and_sync_has_no_pending_reviewers(self):
        self.start_bot_fix()
        self.assertIn("run the gate first", self.advance("approve", code=1))
        self.command("gate", self.job_id)
        checks = self.round_dir(2) / "checks.md"
        checks.write_text(checks.read_text().replace(self.head, "b" * 40))
        self.assertIn("written for another commit", self.advance("approve", code=1))
        self.command("gate", self.job_id)
        self.advance("approve")
        self.command("job", "sync", self.job_id)
        job = self.read_job()
        self.assertEqual(job["stage"], "approve")
        self.assertEqual(job["round_kind"], "bot-fix")
        self.assertEqual(job["round_kinds"], {"1": "normal", "2": "bot-fix"})
        self.assertEqual(job["reviews"], {})
        self.assertEqual(list(self.round_dir(2).glob("review-*.md")), [])

    def test_failing_gate_starts_another_bot_fix_round(self):
        self.start_bot_fix()
        self.checks.write_text("exit 1\n")
        self.command("gate", self.job_id, code=1)
        self.assertIn("gate didn't pass", self.advance("approve", code=1))
        self.advance("build")
        job = self.read_job()
        self.assertEqual((job["round"], job["round_limit"], job["round_kind"]), (3, 3, "bot-fix"))
        self.assertEqual(job["round_kinds"], {"1": "normal", "2": "bot-fix", "3": "bot-fix"})
        self.push_commit("Fix gate failure")
        self.advance("gate")
        self.checks.write_text("exit 0\n")
        self.command("gate", self.job_id)
        self.advance("approve")

    def test_normal_round_must_go_through_review(self):
        self.advance("gate")
        self.command("gate", self.job_id)
        legacy = self.read_job()
        legacy.pop("round_kind", None)
        legacy.pop("round_kinds", None)
        self.job_path.write_text(json.dumps(legacy))
        self.assertIn("only bot-fix rounds", self.advance("approve", code=1))
        self.assertEqual(self.read_job()["stage"], "gate")
        self.advance("review")
        job = self.read_job()
        self.assertEqual(job["round_kind"], "normal")
        self.assertEqual(job["reviews"], {"code": "pending"})

    def test_merge_uses_current_bot_pass_with_internal_reviews_in_prior_round(self):
        self.start_bot_fix()
        self.command("gate", self.job_id)
        self.advance("approve")
        self.update_forge(reviewThreads=[thread(resolved=True)])
        (self.round_dir(2) / "reviews.md").write_text(f"REVIEWS: PASS\nCOMMIT: {self.head}\n")
        (self.job_dir / "decision.md").write_text("APPROVE\n")
        self.assertIn("merged PR #99", self.command("job", "merge", self.job_id))
        job = self.read_job()
        self.assertEqual((job["stage"], job["reviews_gate"], job["reviews"]), ("merged", "PASS", {}))
        self.assertEqual(list(self.round_dir(2).glob("review-*.md")), [])
