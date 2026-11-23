"""Run doctor against a disposable checkout and local-only dependencies."""

from contextlib import ExitStack
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
from threading import Thread
import unittest

FACTORY = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"


class DoctorTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "checkout"
        self.factory = self.root / "factory"
        (self.factory / "bin").mkdir(parents=True)
        for name in ("doctor", "forge", "dashboard"):
            shutil.copy2(FACTORY / "bin" / name, self.factory / "bin" / name)

        self.fake_bin = Path(tmp.name) / "bin"
        self.fake_bin.mkdir()
        for name in ("bash", "git"):
            (self.fake_bin / name).symlink_to(shutil.which(name))
        (self.fake_bin / "python3").symlink_to(sys.executable)
        self.fake_cli("gh", '[ "$*" = "api user --jq .login" ] || exit 2\necho fixture-user\n')
        self.fake_cli("agent-browser", "exit 0\n")
        self.env = {"PATH": str(self.fake_bin), "HOME": tmp.name,
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        self.git("init", "-q", "-b", "main")

        with socket.socket() as sock:
            sock.bind((HOST, 0))
            self.config = {"dashboard": {"port": sock.getsockname()[1]}, "concurrency": 2}
            self.set_job_ports()

    def fake_cli(self, name, body):
        exe = self.fake_bin / name
        exe.write_text("#!/bin/sh\n" + body)
        exe.chmod(0o755)

    def git(self, *args, code=0):
        result = subprocess.run(["git", *args], cwd=self.root, env=self.env,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)

    def set_job_ports(self, first_job=1, busy_offset=None):
        step = 7
        offsets = (0, 1, 2, step, step + 1, step + 2)
        # On hosts that allocate ephemeral ports in order, choose the range
        # behind the anchor so later connections do not immediately take it.
        anchor = busy_offset if busy_offset is not None else offsets[-1]
        for _ in range(20):
            with ExitStack() as anchored, ExitStack() as adjacent:
                sock = anchored.enter_context(socket.socket())
                sock.bind((HOST, 0))
                first_port = sock.getsockname()[1] - anchor
                ports = [first_port + offset for offset in offsets]
                if ports[-1] > 65535 or self.config["dashboard"]["port"] in ports:
                    continue
                try:
                    for offset in offsets:
                        if offset != anchor:
                            adjacent.enter_context(socket.socket()).bind((HOST, first_port + offset))
                except OSError:
                    continue
                self.config["ports"] = {"base": first_port - step * first_job, "step": step}
                if busy_offset is not None:
                    sock.listen()
                    self.addCleanup(anchored.pop_all().close)
                return first_port + anchor
        self.fail("could not find a free set of job ports")

    def run_doctor(self, code=0):
        (self.factory / "config.json").write_text(json.dumps(self.config))
        result = subprocess.run([str(self.factory / "bin/doctor")], cwd=self.root.parent,
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 7, result.stdout)
        self.assertEqual(lines[-1], "DOCTOR: FAIL" if code else "DOCTOR: PASS")
        return result.stdout

    def test_all_builtin_checks_pass_without_hook(self):
        out = self.run_doctor()
        self.assertEqual(out.count("PASS  "), 5)
        self.assertIn("PASS  Forge auth: authenticated as fixture-user", out)
        self.assertIn("PASS  Job port range: 6 ports free", out)
        self.assertIn("PASS  Browser CLI: agent-browser is on PATH", out)
        self.assertIn("SKIP  factory/preflight.sh: no repo hook", out)

    def test_passing_hook_runs_from_repo_root(self):
        (self.factory / "preflight.sh").write_text("test -f factory/config.json\n")
        self.assertIn("PASS  factory/preflight.sh:", self.run_doctor())

    def test_failing_hook_reports_its_exit_and_output_on_one_line(self):
        (self.factory / "preflight.sh").write_text("echo 'Database unavailable'\necho 'Start it' >&2\nexit 7\n")
        out = self.run_doctor(code=1)
        self.assertIn("FAIL  factory/preflight.sh: hook exited 7: Database unavailable Start it", out)

    def test_dashboard_port_override_refuses_a_foreign_listener(self):
        with socket.socket() as other:
            other.bind((HOST, 0))
            other.listen()
            port = other.getsockname()[1]
            self.env["FACTORY_DASHBOARD_PORT"] = str(port)
            self.assertIn(f"FAIL  Dashboard port: port {port} is in use", self.run_doctor(code=1))
            self.config["dashboard"]["open"] = False
            self.assertIn("SKIP  Dashboard port:", self.run_doctor())

    def test_existing_dashboard_with_matching_checkout_token_passes(self):
        jobs = self.factory / "jobs"
        jobs.mkdir()
        (jobs / ".dashboard.token").write_text("fixture-token\n")

        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        with ThreadingHTTPServer((HOST, 0), partial(QuietHandler, directory=self.factory)) as server:
            thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
            thread.start()
            try:
                port = server.server_port
                self.env["FACTORY_DASHBOARD_PORT"] = str(port)
                self.assertIn(f"PASS  Dashboard port: this checkout's dashboard is serving on port {port}",
                              self.run_doctor())
            finally:
                server.shutdown()
                thread.join()

    def test_bound_port_in_last_upcoming_slot_fails(self):
        jobs = self.factory / "jobs"
        (jobs / "007-previous").mkdir(parents=True)
        (jobs / "unrelated").mkdir()
        (jobs / "999-file").touch()
        port = self.set_job_ports(first_job=8, busy_offset=9)
        self.assertIn(f"FAIL  Job port range: ports already in use: {port}.", self.run_doctor(code=1))

    def test_job_ports_only_check_free_concurrency_slots(self):
        jobs = self.factory / "jobs"
        for job_id in ("001-first", "002-second"):
            job = jobs / job_id / "job.json"
            job.parent.mkdir(parents=True)
            job.write_text(json.dumps({"stage": "build", "round": 1, "ended": None}))

        port = self.set_job_ports(first_job=3, busy_offset=0)
        self.assertIn("SKIP  Job port range: no free job slots", self.run_doctor())

        job = jobs / "002-second" / "job.json"
        job.write_text(json.dumps({"stage": "needs-human", "round": 1, "ended": "2026-11-23T00:00:00Z"}))
        self.assertIn(f"FAIL  Job port range: ports already in use: {port}.", self.run_doctor(code=1))

        self.set_job_ports(first_job=3, busy_offset=7)
        self.assertIn("PASS  Job port range: 3 ports free", self.run_doctor())

    def test_missing_browser_reports_configured_setup(self):
        self.config["browser"] = {"cli": "fixture-browser", "setup": "Install the fixture browser"}
        self.assertIn("FAIL  Browser CLI: fixture-browser is missing from PATH. "
                      "Follow browser.setup: Install the fixture browser", self.run_doctor(code=1))

    def test_explicitly_disabled_browser_is_skipped(self):
        (self.fake_bin / "agent-browser").unlink()
        for browser in (None, False, {"cli": ""}):
            with self.subTest(browser=browser):
                self.config["browser"] = browser
                self.assertIn("SKIP  Browser CLI: disabled", self.run_doctor())

    def test_computer_use_accepts_chrome_or_the_fallback_cli(self):
        app = "Factory Fixture Chrome"
        self.config["browser"] = {"computer_use": True, "chrome_app": app, "cli": "agent-browser"}
        self.assertIn(f"PASS  Browser CLI: {app} is unavailable for computer use. Fallback: agent-browser is on PATH",
                      self.run_doctor())
        (self.fake_bin / "agent-browser").unlink()
        self.assertIn(f"FAIL  Browser CLI: {app} is unavailable for computer use. Fallback: agent-browser is missing",
                      self.run_doctor(code=1))
        if sys.platform == "darwin":
            self.fake_cli("open", f'[ "$#" = 2 ] && [ "$1" = "-Ra" ] && [ "$2" = "{app}" ]\n')
        else:
            self.fake_cli("chromium", "exit 0\n")
        self.assertIn(f"PASS  Browser CLI: {app} is available for computer use. Fallback: agent-browser is missing",
                      self.run_doctor())

    def test_unauthenticated_forge_reports_cli_error(self):
        self.fake_cli("gh", "echo 'Authenticate with gh auth login' >&2\nexit 1\n")
        self.assertIn("failed: Authenticate with gh auth login", self.run_doctor(code=1))

    def test_missing_forge_cli_fails_cleanly(self):
        (self.fake_bin / "gh").unlink()
        self.assertIn("FAIL  Forge auth:", self.run_doctor(code=1))

    def test_conflicted_checkout_and_merge_in_progress_both_fail(self):
        self.git("config", "user.name", "Doctor Fixture")
        self.git("config", "user.email", "doctor@example.test")
        tracked = self.root / "tracked file.txt"
        tracked.write_text("base\n")
        self.git("add", tracked.name)
        self.git("commit", "-qm", "base")
        self.git("checkout", "-qb", "other")
        tracked.write_text("other\n")
        self.git("commit", "-qam", "other")
        self.git("checkout", "-q", "main")
        tracked.write_text("main\n")
        self.git("commit", "-qam", "main")
        self.git("merge", "other", code=1)
        self.assertIn("FAIL  Main checkout conflicts: unmerged files: tracked file.txt", self.run_doctor(code=1))
        self.git("add", tracked.name)
        self.assertIn("FAIL  Main checkout conflicts: a merge is in progress", self.run_doctor(code=1))


if __name__ == "__main__":
    unittest.main()
