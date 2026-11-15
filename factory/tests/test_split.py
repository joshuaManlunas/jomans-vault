import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
INTAKE = "DECISION: SPLIT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n"
CHILDREN = """## Summary
Split this work into two steps.

## Children

### 1. Foundation

Depends on: none
Build the foundation.

### 2. Follow-up
Depends on: 1
Use the foundation.

## Notes
Not part of a child body.
"""

# A strict, stateful fake: unexpected commands fail rather than touching GitHub.
FAKE_GH = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
state_path = Path(os.environ["FAKE_GH_STATE"])
state = json.loads(state_path.read_text())
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")

def option(name):
    return args[args.index(name) + 1]

if args[:2] == ["api", "user"]:
    print("operator")
elif args[:2] == ["issue", "view"]:
    print(json.dumps(state["issues"][args[2]]))
elif args[:2] == ["issue", "list"]:
    print(json.dumps([
        {"number": i["number"], "title": i["title"]}
        for i in state["issues"].values()
        if i["state"] == "OPEN" and option("--label") in [l["name"] for l in i["labels"]]
    ]))
elif args[:2] == ["issue", "create"]:
    if state.get("fail_create") == state["next_issue"]:
        sys.exit("simulated create failure")
    n = state["next_issue"]
    state["next_issue"] += 1
    url = f"https://github.com/test/repo/issues/{n}"
    state["issues"][str(n)] = {
        "number": n, "title": option("--title"), "body": option("--body"),
        "author": {"login": "operator"}, "labels": [{"name": option("--label")}],
        "state": "OPEN", "url": url, "comments": [],
    }
    print(url)
elif args[:2] == ["issue", "edit"]:
    issue = state["issues"][args[2]]
    labels = {l["name"] for l in issue["labels"]}
    if "--remove-label" in args:
        labels -= set(option("--remove-label").split(","))
    if "--add-label" in args:
        labels |= set(option("--add-label").split(","))
    issue["labels"] = [{"name": l} for l in sorted(labels)]
elif args[:2] == ["issue", "comment"]:
    pass
elif args[:2] == ["issue", "close"]:
    state["issues"][args[2]]["state"] = "CLOSED"
elif args[:2] == ["pr", "view"]:
    print(json.dumps({"state": state.get("pr_state", "OPEN")}))
elif args[0] == "api" and args[1].startswith("repos/{owner}/{repo}/issues/"):
    if state.get("fail_links") and args[1].endswith("/sub_issues"):
        sys.exit("sub-issues unavailable")
    if args[1].endswith("/sub_issues"):
        assert args[2:4] == ["-X", "POST"]
        assert option("-F").startswith("sub_issue_id=")
        print("{}")
    else:
        assert option("--jq") == ".id"
        print(int(args[1].split("/")[-1]) + 1000)
else:
    sys.exit("unexpected gh call: " + repr(args))
state_path.write_text(json.dumps(state))
'''



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

class SplitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.factory = self.root / "factory"
        (self.factory / "bin").mkdir(parents=True)
        shutil.copy2(REPO / "factory/bin/job", self.factory / "bin/job")
        shutil.copy2(REPO / "factory/bin/forge", self.factory / "bin/forge")
        copy_config(REPO / "factory/config.json", self.factory / "config.json")
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        fake = fake_bin / "gh"
        fake.write_text(FAKE_GH)
        fake.chmod(0o755)
        self.state_path = self.root / "gh-state.json"
        self.log_path = self.root / "gh-log.jsonl"
        self.state_path.write_text(json.dumps({"issues": {"10": {
            "number": 10, "title": "Parent", "body": "Large request",
            "author": {"login": "author"}, "labels": [{"name": "factory"}],
            "state": "OPEN", "url": "https://github.com/test/repo/issues/10", "comments": [],
        }}, "next_issue": 101}))
        self.env = {
            **os.environ, "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
            "FAKE_GH_STATE": str(self.state_path), "FAKE_GH_LOG": str(self.log_path),
            "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
        }
        self.parent_id = self.job("create", "10").stdout.strip()
        self.parent_dir = self.factory / "jobs" / self.parent_id
        self.intake()

    def job(self, *args, ok=True, text=None):
        result = subprocess.run(
            [sys.executable, str(self.factory / "bin/job"), *args],
            cwd=self.root, env=self.env, input=text, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0 if ok else 1, result.stdout + result.stderr)
        return result

    def config(self, **changes):
        path = self.factory / "config.json"
        config = json.loads(path.read_text())
        config.update(changes)
        path.write_text(json.dumps(config))

    def state(self, **changes):
        state = json.loads(self.state_path.read_text())
        state.update(changes)
        self.state_path.write_text(json.dumps(state))
        return state

    def calls(self, *prefix):
        calls = [json.loads(line) for line in self.log_path.read_text().splitlines()]
        return [call for call in calls if call[:len(prefix)] == list(prefix)]

    def intake(self, children=CHILDREN, decision="SPLIT"):
        (self.parent_dir / "intake.md").write_text(INTAKE.replace("SPLIT", decision) + children)

    def read_job(self, job_id=None):
        return json.loads((self.factory / "jobs" / (job_id or self.parent_id) / "job.json").read_text())

    def update_job(self, job_id=None, **changes):
        job_id = job_id or self.parent_id
        job = self.read_job(job_id)
        job.update(changes)
        (self.factory / "jobs" / job_id / "job.json").write_text(json.dumps(job))

    def split(self):
        self.config(auto_split=True)
        return self.job("split", self.parent_id)

    def test_split_creates_real_dependencies_and_survives_sub_issue_failure(self):
        self.state(fail_links=True)
        result = self.split()
        self.assertIn("couldn't link #101", result.stderr)
        self.assertIn(f"{self.parent_id}: split into #101, #102", result.stdout)
        parent = self.read_job()
        self.assertEqual(parent["stage"], "split")
        self.assertEqual(parent["children"], [
            {"issue": 101, "title": "Foundation", "depends_on": []},
            {"issue": 102, "title": "Follow-up", "depends_on": [101]},
        ])
        issues = self.state()["issues"]
        self.assertEqual(issues["101"]["body"], "Build the foundation.\n\nPart of #10")
        self.assertEqual(issues["102"]["body"], "Use the foundation.\n\nPart of #10\nDepends on #101")
        self.assertEqual(issues["101"]["labels"], [{"name": "factory"}])
        self.assertEqual(len(self.calls("issue", "create")), 2)

    def test_split_resumes_recorded_children_without_duplicate_creation(self):
        self.config(auto_split=True)
        self.state(fail_create=102)
        self.job("split", self.parent_id, ok=False)
        self.assertEqual([c["issue"] for c in self.read_job()["children"]], [101])
        self.assertEqual(self.read_job()["stage"], "intake")
        self.state(fail_create=None)
        self.job("split", self.parent_id)
        creates = self.calls("issue", "create")
        self.assertEqual([c[c.index("--title") + 1] for c in creates], ["Foundation", "Follow-up", "Follow-up"])
        links = [c for c in self.calls("api") if c[1].endswith("/sub_issues")]
        self.assertEqual([c[c.index("-F") + 1] for c in links], ["sub_issue_id=1101", "sub_issue_id=1102"])

    def test_split_accepts_six_children_and_maps_comma_dependencies(self):
        self.intake("## Children\n" + "\n".join(
            f"### {n}. Child {n}\nDepends on: {'none' if n < 3 else '1, 2'}\nScope {n}"
            for n in range(1, 7)))
        self.split()
        self.assertEqual(len(self.read_job()["children"]), 6)
        self.assertEqual(self.read_job()["children"][-1]["depends_on"], [101, 102])
        self.assertEqual(self.state()["issues"]["106"]["body"],
                         "Scope 6\n\nPart of #10\nDepends on #101, #102")
        self.assertIn("hold\t106\t-\t-\twaiting on #101, #102", self.job("queue").stdout)

    def test_invalid_children_are_refused_before_any_issue_is_created(self):
        self.config(auto_split=True)
        cases = [
            ("forward", CHILDREN.replace("Depends on: none", "Depends on: 2"), "lower-numbered"),
            ("self", CHILDREN.replace("Depends on: 1", "Depends on: 2"), "lower-numbered"),
            ("zero", CHILDREN.replace("Depends on: 1", "Depends on: 0"), "lower-numbered"),
            ("gap", CHILDREN.replace("### 2.", "### 3."), "consecutively"),
            ("missing deps", CHILDREN.replace("Depends on: none\n", ""), "first non-blank"),
            ("invalid deps", CHILDREN.replace("Depends on: 1", "Depends on: #1"), "first non-blank"),
            ("one child", CHILDREN.split("### 2.")[0], "at least 2"),
            ("seven children", "## Children\n" + "\n".join(
                f"### {n}. Child {n}\nDepends on: none\nScope" for n in range(1, 8)), "at most 6"),
            ("missing section", "## Summary\nNo children", "missing ## Children"),
        ]
        for name, body, error in cases:
            with self.subTest(case=name):
                self.intake(body)
                result = self.job("split", self.parent_id, ok=False)
                self.assertIn(error, result.stderr)
                self.assertEqual(self.calls("issue", "create"), [])
                self.assertIsNone(self.read_job()["children"])

    def test_split_requires_approval_and_cannot_be_advanced_directly(self):
        self.job("split", self.parent_id, ok=False)
        self.job("advance", self.parent_id, "split", ok=False)
        self.job("advance", self.parent_id, "needs-human")
        comments = self.calls("issue", "comment")
        self.assertEqual(len(comments), 1)
        self.assertIn("<!-- factory -->", comments[0][-1])
        self.assertIn(CHILDREN.strip(), comments[0][-1])
        self.assertNotIn("DECISION:", comments[0][-1])
        self.assertFalse((self.parent_dir / "decision.md").exists())
        self.assertEqual(self.read_job()["stage"], "needs-human")
        self.job("advance", self.parent_id, "build", ok=False)
        self.job("advance", self.parent_id, "intake", ok=False)
        stale = self.parent_dir / "feedback-1.md"
        stale.write_text("Earlier feedback")
        os.utime(stale, ns=(1_000_000_000, 1_000_000_000))
        self.job("advance", self.parent_id, "intake", ok=False)
        self.job("advance", self.parent_id, "split", ok=False)
        self.job("split", self.parent_id)
        labels = self.state()["issues"]["10"]["labels"]
        self.assertEqual(labels, [{"name": "factory"}])
        self.job("split", self.parent_id, ok=False)

    def test_only_split_intakes_can_escalate_or_split(self):
        for decision in ["ACCEPT", "NEEDS-INFO", "REJECT"]:
            with self.subTest(decision=decision):
                self.intake(decision=decision)
                self.job("advance", self.parent_id, "needs-human", ok=False)
                self.job("split", self.parent_id, ok=False)
        self.intake()
        self.config(auto_split=True)
        self.job("advance", self.parent_id, "needs-human", ok=False)

    def test_split_feedback_archives_intake_instead_of_starting_build(self):
        self.job("advance", self.parent_id, "needs-human")
        # Explicit mtimes keep this deterministic, including on coarse filesystems.
        os.utime(self.parent_dir / "intake.md", ns=(1_000_000_000, 1_000_000_000))
        self.job("feedback", self.parent_id, text="Try a different split")
        self.assertEqual(self.read_job()["stage"], "intake")
        self.assertIsNone(self.read_job()["intake"])
        self.assertEqual(self.read_job()["round"], 0)
        self.assertTrue((self.parent_dir / "intake-1.md").exists())
        self.assertFalse((self.parent_dir / "intake.md").exists())
        self.assertIn("Try a different split", (self.parent_dir / "feedback-1.md").read_text())
        self.assertTrue((self.parent_dir / "issue.md").exists())
        self.assertEqual(self.state()["issues"]["10"]["labels"], [{"name": "factory"}])

    def test_only_trusted_local_records_establish_dependencies(self):
        state = self.state()
        state["issues"]["10"]["body"] = "Part of #99\nDepends on #98"
        self.state(issues=state["issues"])
        # Drop only the isolated local fixture, then recreate from the untrusted body.
        shutil.rmtree(self.parent_dir)
        self.assertIn("new\t10\t-\t-", self.job("queue").stdout)
        job_id = self.job("create", "10").stdout.strip()
        self.assertIsNone(self.read_job(job_id)["parent"])

    def test_queue_and_create_hold_children_until_recorded_dependencies_merge(self):
        self.split()
        self.config(concurrency=1)
        queue = self.job("queue").stdout
        self.assertIn("wait\t10\t" + self.parent_id + "\tsplit\tchildren 0/2 merged", queue)
        self.assertIn("new\t101\t-\t-", queue)
        self.assertIn("hold\t102\t-\t-\twaiting on #101", queue)
        blocked = self.job("create", "102", ok=False)
        self.assertIn("hold\t102\t-\t-\twaiting on #101", blocked.stderr)
        child = self.job("create", "101").stdout.strip()
        self.assertEqual(self.read_job(child)["parent"], 10)
        self.assertIsNone(self.read_job(child)["children"])
        self.assertIn("hold\t102\t-\t-\twaiting on #101", self.job("queue").stdout)
        self.update_job(child, stage="merged")
        self.assertIn("new\t102\t-\t-", self.job("queue").stdout)
        next_child = self.job("create", "102").stdout.strip()
        self.assertEqual(self.read_job(next_child)["parent"], 10)

    def test_parent_merge_waits_for_every_child_and_queue_closes_completed_parent(self):
        self.split()
        self.update_job(pr=99)
        self.state(pr_state="MERGED")
        self.job("advance", self.parent_id, "merged", ok=False)
        self.assertIn("\tsplit\tchildren 0/2 merged", self.job("queue").stdout)
        first = self.job("create", "101").stdout.strip()
        self.update_job(first, stage="merged")
        second = self.job("create", "102").stdout.strip()
        self.job("advance", self.parent_id, "merged", ok=False)
        self.assertEqual(self.calls("issue", "close"), [])
        self.update_job(second, stage="merged")
        self.job("advance", self.parent_id, "merged")
        self.assertEqual(self.read_job()["stage"], "merged")
        self.assertEqual(self.calls("issue", "close"), [["issue", "close", "10"]])
        self.assertIn("#101: Foundation", self.calls("issue", "comment")[-1][-1])
        # Exercise automatic queue completion against the same complete child set.
        self.update_job(stage="split")
        self.job("queue")
        self.assertEqual(self.read_job()["stage"], "merged")

    def test_rejecting_split_parent_leaves_child_issues_untouched(self):
        self.split()
        before = self.state()["issues"]
        self.job("reject", self.parent_id, text="Cancel the parent")
        self.assertEqual(self.read_job()["stage"], "rejected")
        after = self.state()["issues"]
        self.assertEqual(after["10"]["labels"], [])
        self.assertEqual([after["101"], after["102"]], [before["101"], before["102"]])
        self.assertEqual(self.calls("issue", "close"), [])

    def test_legacy_jobs_and_non_split_intake_paths_still_work(self):
        legacy = self.read_job()
        self.assertIsNone(legacy.pop("parent"))
        self.assertIsNone(legacy.pop("children"))
        (self.parent_dir / "job.json").write_text(json.dumps(legacy))
        self.intake(decision="NEEDS-INFO")
        self.job("advance", self.parent_id, "needs-info")
        self.assertIsNone(self.read_job()["children"])
        self.job("advance", self.parent_id, "intake")
        self.intake(decision="REJECT")
        self.job("advance", self.parent_id, "rejected")
        self.assertEqual(self.read_job()["stage"], "rejected")
        self.update_job(stage="build", pr=99)
        self.state(pr_state="MERGED")
        self.job("queue")
        self.assertEqual(self.read_job()["stage"], "merged")


if __name__ == "__main__":
    unittest.main()
