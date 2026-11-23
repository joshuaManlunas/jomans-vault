import json
import os
from pathlib import Path
import shutil
import stat
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
        self.config_path = self.factory / "config.json"
        copy_config(REPO / "factory/config.json", self.config_path)
        self.configure(max_rounds=3, browser={}, env_files=[])
        config = json.loads(self.config_path.read_text())
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
                    "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
                    "CODEX_HOME": str(self.root / "codex")}
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
        self.git("config", "core.excludesFile", "/dev/null")
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

    def configure(self, **changes):
        config = json.loads(self.config_path.read_text())
        self.config_path.write_text(json.dumps({**config, **changes}))

    def intake(self, directory, surfaces):
        (directory / "intake.md").write_text(f"DECISION: ACCEPT\nRISK: low\nSURFACES: {surfaces}\n\nAccepted.\n")

    def browser_result(self, verdict, *, head=None, body=""):
        n = self.read_job()["round"]
        (self.round_dir(n) / "browser.md").write_text(f"BROWSER: {verdict}\nCOMMIT: {head or self.head}\n\n{body}")

    def start_bot_fix(self, *, browser=False, changed=True):
        if browser:
            self.intake(self.job_dir, "ui")
        self.advance("gate")
        self.command("gate", self.job_id)
        if browser:
            self.advance("browser")
            self.browser_result("PASS")
        self.advance("review")
        (self.round_dir(1) / "review-code.md").write_text("VERDICT: PASS\n")
        self.advance("approve")
        self.update_forge(reviewThreads=[thread()])
        (self.round_dir(1) / "reviews.md").write_text(f"REVIEWS: FAIL\nCOMMIT: {self.head}\n")
        self.advance("build")
        if changed:
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

    def test_ui_round_requires_a_browser_pass_for_head_before_review(self):
        self.intake(self.job_dir, "ui")
        self.advance("gate")
        self.assertIn("run the gate first", self.advance("browser", code=1))
        self.command("gate", self.job_id)
        self.command("job", "sync", self.job_id)
        self.assertIs(self.read_job()["browser_needed"], True)
        self.assertIsNone(self.read_job()["browser"])
        self.assertIn(f"run the browser stage first: job advance {self.job_id} browser", self.advance("review", code=1))
        self.advance("browser")
        self.assertEqual(self.read_job()["browser"], "pending")
        self.assertIn("missing browser.md", self.advance("review", code=1))
        self.browser_result("PASS", head="b" * 40)
        self.assertIn("browser.md was written for another commit", self.advance("review", code=1))
        self.browser_result("PASS")
        self.assertIn("only bot-fix rounds", self.advance("approve", code=1))
        self.advance("review")
        self.assertEqual((self.read_job()["stage"], self.read_job()["browser"]), ("review", "PASS"))

    def test_browser_is_skipped_without_a_matching_surface_or_enabled_config(self):
        self.advance("gate")
        self.command("gate", self.job_id)
        for surfaces, browser in (("security", {}), ("ui", None), ("ui", False), ("ui", {"surfaces": ["mobile"]})):
            with self.subTest(surfaces=surfaces, browser=browser):
                self.intake(self.job_dir, surfaces)
                self.configure(browser=browser)
                self.command("job", "sync", self.job_id)
                self.assertIs(self.read_job()["browser_needed"], False)
                self.assertIsNone(self.read_job()["browser"])
                self.assertIn("the browser stage isn't needed", self.advance("browser", code=1))
        with self.subTest("config without a browser-tester role"):
            roles = {k: v for k, v in json.loads(self.config_path.read_text())["roles"].items()
                     if k != "browser-tester"}
            self.intake(self.job_dir, "ui")
            self.configure(browser={"cli": "agent-browser"}, roles=roles)
            self.command("job", "sync", self.job_id)
            self.assertIs(self.read_job()["browser_needed"], False)
        self.advance("review")

    def test_bot_fix_skips_browser_when_head_already_passed(self):
        self.start_bot_fix(browser=True, changed=False)
        self.command("gate", self.job_id)
        self.advance("approve")
        self.assertIs(self.read_job()["browser_needed"], False)
        self.assertIsNone(self.read_job()["browser"])

    def test_new_bot_fix_head_needs_browser_and_failure_preserves_round_kind(self):
        self.start_bot_fix(browser=True)
        self.command("gate", self.job_id)
        self.assertIn(f"run the browser stage first: job advance {self.job_id} browser", self.advance("approve", code=1))
        self.advance("browser")
        self.browser_result("FAIL")
        self.command("job", "sync", self.job_id)
        self.assertEqual(self.read_job()["browser"], "FAIL")
        self.assertIn("the browser test didn't pass", self.advance("approve", code=1))
        self.assertIn("round 2 of 3: go to build", self.advance("needs-human", code=1))
        self.advance("build")
        job = self.read_job()
        self.assertEqual((job["round"], job["round_kind"], job["browser"]), (3, "bot-fix", None))
        self.assertEqual(job["round_kinds"], {"1": "normal", "2": "bot-fix", "3": "bot-fix"})
        self.advance("gate")
        self.command("gate", self.job_id)
        self.advance("browser")
        self.browser_result("PASS")
        self.assertIn("bot-fix rounds must advance from browser to approve", self.advance("review", code=1))
        self.advance("approve")
        self.assertEqual(self.read_job()["stage"], "approve")

    def test_browser_last_round_failure_escalates(self):
        self.intake(self.job_dir, "ui")
        self.job_path.write_text(json.dumps({**self.read_job(), "round_limit": 1}))
        self.advance("gate")
        self.command("gate", self.job_id)
        self.advance("browser")
        self.browser_result("FAIL")
        self.assertIn("round 1 of 1: go to needs-human", self.advance("build", code=1))
        self.advance("needs-human")
        self.assertEqual((self.read_job()["stage"], self.read_job()["browser"]), ("needs-human", "FAIL"))
        self.assertIn("The browser test failed in round 1, the last allowed round.",
                      (self.job_dir / "decision.md").read_text())

    def test_blocked_browser_escalates_with_the_blocked_section(self):
        self.intake(self.job_dir, "ui")
        self.advance("gate")
        self.command("gate", self.job_id)
        self.advance("browser")
        self.browser_result("BLOCKED", body="## Blocked\nThe dev server would not start.\n\n## Notes\nExtra notes.\n")
        self.assertIn("browser.md must start with BROWSER: FAIL", self.advance("build", code=1))
        self.advance("needs-human")
        self.assertEqual((self.read_job()["stage"], self.read_job()["browser"]), ("needs-human", "BLOCKED"))
        reason = (self.job_dir / "decision.md").read_text()
        self.assertIn("The dev server would not start.", reason)
        self.assertNotIn("Extra notes.", reason)

    def test_browser_slot_is_released_on_leaving_the_stage(self):
        self.intake(self.job_dir, "ui")
        self.advance("gate")
        self.command("gate", self.job_id)
        other = "002-other"
        other_dir = self.job_dir.parent / other
        shutil.copytree(self.job_dir, other_dir)
        other_path = other_dir / "job.json"
        other_path.write_text(json.dumps({**self.read_job(), "id": other, "issue": 11}))
        self.advance("browser")
        out = self.command("job", "advance", other, "browser", code=1)
        self.assertIn(f"browser busy: {self.job_id}", out)
        self.assertEqual(json.loads(other_path.read_text())["stage"], "gate")
        self.browser_result("PASS")
        self.advance("review")
        self.command("job", "advance", other, "browser")
        self.assertEqual(json.loads(other_path.read_text())["stage"], "browser")

    def test_intake_copies_only_files_ignored_in_the_new_worktree(self):
        ignored, skipped = "apps/web/.env", "apps/web/.env.local"
        literal = f":(top){ignored}"
        (self.root / ".gitignore").write_text(ignored + "\n")
        self.git("add", ".gitignore")
        self.git("commit", "-m", "Ignore the test environment file")
        self.git("push", "origin", "main")
        (self.root / ".gitignore").write_text(f"{ignored}\n{skipped}\n")
        values = {ignored: "REVIEW_PASSWORD=fixture-not-for-logs\n", skipped: "OTHER=fixture-not-for-copy\n",
                  literal: "LITERAL=fixture-not-for-copy\n"}
        for path, value in values.items():
            source = self.root / path
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(value)
        (self.root / ignored).chmod(0o644)
        self.configure(env_files=list(values))
        issues = json.loads(self.state_path.read_text())["issues"]
        issues["11"] = {**issues["10"], "number": 11, "title": "Browser env"}
        self.update_forge(issues=issues)
        other = self.command("job", "create", "11").strip()
        other_dir = self.job_dir.parent / other
        self.intake(other_dir, "ui")
        self.command("job", "agents", other, json.dumps({"reviewers": {"code": {}}}))
        out = self.command("job", "advance", other, "spec")
        job = json.loads((other_dir / "job.json").read_text())
        copied = Path(job["worktree"]) / ignored
        self.assertEqual(copied.read_text(), values[ignored])
        self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o600)
        for path in (skipped, literal):
            self.assertFalse((Path(job["worktree"]) / path).exists())
            self.assertIn(f"skipping env file {path!r}; git does not ignore it", out)
        for value in values.values():
            self.assertNotIn(value.strip(), out)
