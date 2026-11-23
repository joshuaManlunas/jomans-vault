import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request

REPO = Path(__file__).resolve().parents[2]


# Runs the page's own poll() and loadJobs() in node against the real server; the
# DOM is reduced to the status line and a regex link reader for directory listings.
POLL_HARNESS = r"""
const [base, src] = process.argv.slice(1)
const realFetch = fetch
globalThis.fetch = (url, opts) => realFetch(base + url, opts)
globalThis.DOMParser = class {
  parseFromString(html) {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
    return { querySelectorAll: () => hrefs.map((h) => ({ getAttribute: () => h })) }
  }
}
const status = { className: '', innerHTML: '' }
const $ = () => status
let jobs = [], prLabel = 'PR', openJobId = null
const render = async () => {}
eval(src)
poll().then(() => console.log(JSON.stringify({ status, ids: jobs.map((j) => j.id) })))
"""


def page_functions(*names):
    html = (REPO / "factory/dashboard.html").read_text()
    parts = [re.search(r"^const esc = .*?\n\n", html, re.M | re.S).group()]
    for name in names:
        parts.append(re.search(rf"^(?:async )?function {name}\(.*?^}}\n", html, re.M | re.S).group())
    return "".join(parts)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.port = free_port()
        self.env = {**os.environ, "FACTORY_DASHBOARD_PORT": str(self.port)}
        self.factory = self.make_factory()

    def make_factory(self, parent="checkout"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        factory = Path(tmp.name) / parent / "factory"
        (factory / "bin").mkdir(parents=True)
        shutil.copy2(REPO / "factory/bin/dashboard", factory / "bin/dashboard")
        shutil.copy2(REPO / "factory/dashboard.html", factory / "dashboard.html")
        (factory / "config.json").write_text("{}")
        self.addCleanup(lambda: self.run_dashboard("stop", factory=factory))
        return factory

    def run_dashboard(self, command, code=0, factory=None):
        result = subprocess.run([sys.executable, str((factory or self.factory) / "bin/dashboard"), command],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_detached_server_outlives_its_starter_is_reused_and_stops(self):
        # The 2-hour background-task cap killed the old server; this one must not
        # be tied to the process that started it.
        out = self.run_dashboard("start")
        self.assertIn(f"http://127.0.0.1:{self.port}/dashboard.html (started", out)
        pid = int((self.factory / "jobs/.dashboard.pid").read_text())
        self.assertNotEqual(os.getsid(pid), os.getsid(0), "server shares the caller's session")
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/dashboard.html", timeout=5) as r:
            self.assertEqual(r.status, 200)
        self.assertIn("(already running)", self.run_dashboard("start"))
        self.assertEqual(int((self.factory / "jobs/.dashboard.pid").read_text()), pid)
        self.assertIn("(running, pid", self.run_dashboard("status"))
        self.assertIn(f"stopped (pid {pid})", self.run_dashboard("stop"))
        self.assertIn("not running", self.run_dashboard("status"))

    def test_port_held_by_something_else_is_refused(self):
        with socket.socket() as other:
            other.bind(("127.0.0.1", self.port))
            other.listen()
            out = self.run_dashboard("start", code=1)
        self.assertIn(f"port {self.port} is in use by something else", out)
        self.assertFalse((self.factory / "jobs/.dashboard.pid").exists())

    def test_another_repos_dashboard_on_the_port_is_not_reused(self):
        # Two installs on the default port: the second must not show the first's jobs.
        self.run_dashboard("start")
        other = self.make_factory()
        out = self.run_dashboard("start", code=1, factory=other)
        self.assertIn("another repo's factory dashboard", out)
        self.assertIn("not running for this repo", self.run_dashboard("status", factory=other))


    def test_starting_on_a_new_port_stops_the_previous_server(self):
        # Otherwise the old server is orphaned: `stop` only knows the newest pid.
        self.run_dashboard("start")
        first = int((self.factory / "jobs/.dashboard.pid").read_text())
        old_port, self.env["FACTORY_DASHBOARD_PORT"] = self.port, str(free_port())
        self.assertIn(f"stopped the previous server (pid {first})", self.run_dashboard("start"))
        self.run_dashboard("stop")
        with socket.socket() as s:
            self.assertNotEqual(s.connect_ex(("127.0.0.1", old_port)), 0, "old server still listening")

    def test_a_stale_pid_reused_by_another_server_is_never_killed(self):
        # After a reboot the pid file may name an unrelated http.server.
        other_dir = tempfile.TemporaryDirectory()
        self.addCleanup(other_dir.cleanup)
        other = subprocess.Popen([sys.executable, "-m", "http.server", str(free_port()), "--bind", "127.0.0.1",
                                  "--directory", other_dir.name],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (other.kill(), other.wait()))
        (self.factory / "jobs").mkdir()
        (self.factory / "jobs/.dashboard.pid").write_text(f"{other.pid}\n")
        self.assertIn("not running (nothing this script started)", self.run_dashboard("stop"))
        self.run_dashboard("start")
        self.assertIsNone(other.poll(), "an unrelated server was killed")

    def test_a_checkout_path_with_spaces_is_still_recognised_and_stopped(self):
        # Splitting ps output on whitespace mistook our own server for a stranger.
        self.factory = self.make_factory(parent="my projects/app")
        self.run_dashboard("start")
        pid = int((self.factory / "jobs/.dashboard.pid").read_text())
        self.assertIn(f"stopped (pid {pid})", self.run_dashboard("stop"))

    @unittest.skipUnless(shutil.which("node"), "needs node to run the page's script")
    def test_an_unreadable_job_is_reported_and_clears_once_repaired(self):
        # A broken job.json used to vanish from the board with a healthy status line.
        jobs = self.factory / "jobs"
        for job_id in ("001-good", "002-broken", "003-missing"):
            (jobs / job_id).mkdir(parents=True)
        good = {"id": "001-good", "stage": "build", "cost_usd": 1.5}
        (jobs / "001-good/job.json").write_text(json.dumps(good))
        (jobs / "002-broken/job.json").write_text('{"id": "002-broken", "sta')
        self.run_dashboard("start")
        src = page_functions("fetchText", "poll", "loadJobs")

        def poll():
            out = subprocess.run(["node", "-e", POLL_HARNESS, f"http://127.0.0.1:{self.port}/", src],
                                 capture_output=True, text=True, timeout=20)
            self.assertEqual(out.returncode, 0, out.stderr)
            return json.loads(out.stdout)

        broken = poll()
        self.assertEqual(broken["ids"], ["001-good"])
        self.assertEqual(broken["status"]["className"], "status error")
        self.assertIn("could not read 002-broken, 003-missing", broken["status"]["innerHTML"])

        (jobs / "002-broken/job.json").write_text(json.dumps({**good, "id": "002-broken"}))
        (jobs / "003-missing/job.json").write_text(json.dumps({**good, "id": "003-missing"}))
        repaired = poll()
        self.assertEqual(repaired["ids"], ["001-good", "002-broken", "003-missing"])
        self.assertEqual(repaired["status"]["className"], "status")
        self.assertNotIn("could not read", repaired["status"]["innerHTML"])


if __name__ == "__main__":
    unittest.main()
