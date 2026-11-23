import json
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest


FACTORY = Path(__file__).resolve().parents[1]
DEFAULT = runpy.run_path(str(FACTORY / "bin" / "models"), run_name="factory_models")["DEFAULT"]
PRICE = {"input": 1.0, "output": 1.0, "cache_write_5m": 1.0, "cache_write_1h": 1.0, "cache_read": 1.0}
# The shape T3's orchestrator_capabilities returns, trimmed to what models reads.
CAPABILITIES = {
    "inheritedProviderInstanceId": "claudeAgent",
    "providers": [
        {"providerInstanceId": "claudeAgent", "canRunChildTask": True, "canRunCrossProviderChildTask": True,
         "models": [
             {"id": "claude-opus-5-5", "options": [{"id": "effort", "values": ["medium", "high"]},
                                                   {"id": "fastMode", "values": [False, True]}]},
             {"id": "claude-sonnet-5-5", "options": [{"id": "effort", "values": ["medium", "high"]}]},
             {"id": "claude-haiku-5-5", "options": [{"id": "effort", "values": ["medium"]}]},
             {"id": "claude-unpriced-9", "options": []},
         ]},
        {"providerInstanceId": "codex", "canRunChildTask": True, "canRunCrossProviderChildTask": True,
         "models": [{"id": "gpt-6-astra", "options": [{"id": "reasoningEffort", "values": ["high", "xhigh"]}]}]},
        {"providerInstanceId": "grok", "canRunChildTask": False, "models": [{"id": "grok-build"}]},
    ],
}


class ModelsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.factory = Path(tmp.name) / "factory"
        (self.factory / "bin").mkdir(parents=True)
        (self.factory / "jobs").mkdir()
        for script in ("models", "route"):
            shutil.copy(FACTORY / "bin" / script, self.factory / "bin" / script)
        # A fixed setup, so a customized live config can't change what these tests see.
        config = json.loads((FACTORY / "config.json").read_text()) | json.loads(json.dumps(DEFAULT))
        config["prices_usd_per_mtok"] = {m: PRICE for m in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")}
        (self.factory / "config.json").write_text(json.dumps(config))
        self.caps = Path(tmp.name) / "caps.json"
        self.caps.write_text(json.dumps(CAPABILITIES))

    def run_bin(self, script, *args):
        return subprocess.run([str(self.factory / "bin" / script), *args], capture_output=True, text=True)

    def set(self, *assignments):
        return self.run_bin("models", "set", *assignments, "--available", str(self.caps))

    def config(self):
        return json.loads((self.factory / "config.json").read_text())

    def test_set_routes_the_role_to_the_chosen_model(self):
        res = self.set("builder=codex/gpt-6-astra:reasoningEffort=xhigh",
                       "approver=claudeAgent/claude-opus-5-5:effort=high,fastMode=true")
        self.assertEqual(res.returncode, 0, res.stderr)
        for role, expected in (
            ("builder", {"providerInstanceId": "codex", "model": "gpt-6-astra",
                         "options": {"reasoningEffort": "xhigh"}}),
            ("approver", {"providerInstanceId": "claudeAgent", "model": "claude-opus-5-5",
                          "options": {"effort": "high", "fastMode": True}}),
        ):
            with self.subTest(role=role):
                out = self.run_bin("route", "--target", role)
                self.assertEqual(json.loads(out.stdout), expected, out.stderr)

    def test_set_reuses_an_identical_profile(self):
        before = self.config()["models"]
        self.assertEqual(self.set("intake=claudeAgent/claude-opus-5-5:effort=high").returncode, 0)
        cfg = self.config()
        self.assertEqual(cfg["roles"]["intake"], "opus")
        self.assertEqual(cfg["models"], before)

    def test_set_refuses_and_leaves_config_untouched(self):
        before = (self.factory / "config.json").read_text()
        valid = "builder=codex/gpt-6-astra:reasoningEffort=high"
        for bad, reason in (
            ("intake=grok/grok-build", "isn't available"),
            ("intake=codex/gpt-7", "isn't available"),
            ("intake=claudeAgent/claude-opus-5-5:effort=max", "isn't offered"),
            ("intake=claudeAgent/claude-opus-5-5:depth=high", "no option"),
            ("routing.high.code=claudeAgent/claude-haiku-5-5", "Haiku"),
            ("intake=claudeAgent/claude-unpriced-9", "no price"),
            ("routing.urgent.code=codex/gpt-6-astra", "unknown slot"),
        ):
            with self.subTest(bad=bad):
                res = self.set(valid, bad)
                self.assertNotEqual(res.returncode, 0)
                self.assertIn(reason, res.stderr)
                self.assertEqual((self.factory / "config.json").read_text(), before)

    def test_unused_profiles_are_dropped_unless_a_job_uses_them(self):
        self.set("routing.low.code=codex/gpt-6-astra:reasoningEffort=high",
                 "routing.high.code=codex/gpt-6-astra:reasoningEffort=xhigh")
        job = self.factory / "jobs" / "7-x"
        job.mkdir()
        job.joinpath("job.json").write_text(json.dumps({"agents": {"reviewers": {"code": "astra-xhigh"}}}))
        self.set("routing.low.code=claudeAgent/claude-sonnet-5-5:effort=high",
                 "routing.high.code=claudeAgent/claude-sonnet-5-5:effort=high",
                 "intake=claudeAgent/claude-sonnet-5-5:effort=high")
        models = self.config()["models"]
        self.assertNotIn("astra", models)
        self.assertIn("astra-xhigh", models)  # the in-flight job still resolves its reviewer
        self.assertIn("fable", models)  # default profiles stay even when unused

    def test_show_marks_a_saved_option_the_catalog_lacks(self):
        cfg = self.config()
        cfg["models"]["opus"]["options"]["effort"] = "max"  # the catalog offers medium and high
        (self.factory / "config.json").write_text(json.dumps(cfg))
        out = self.run_bin("models", "show", "--available", str(self.caps)).stdout
        spec = next(line for line in out.splitlines() if line.startswith("spec-writer"))
        self.assertIn("NOT AVAILABLE: effort=max not offered", spec)

    def test_reset_keeps_a_routed_jobs_customized_profile(self):
        cfg = self.config()
        cfg["models"]["opus"]["options"]["effort"] = "medium"
        (self.factory / "config.json").write_text(json.dumps(cfg))
        job = self.factory / "jobs" / "7-x"
        job.mkdir()
        job.joinpath("job.json").write_text(json.dumps({"agents": {"reviewers": {"code": "opus"}}}))
        self.assertEqual(self.run_bin("models", "reset").returncode, 0)
        routed = json.loads(self.run_bin("route", "--target", "reviewer-code", "7-x").stdout)
        self.assertEqual(routed["options"], {"effort": "medium"})
        restored = self.config()["routing"]["low"]["code"]
        self.assertEqual(self.config()["models"][restored]["options"], {"effort": "high"})

    def test_reset_restores_the_default_setup(self):
        self.set("intake=codex/gpt-6-astra:reasoningEffort=high", "surface_reviewers.ui.ux=codex/gpt-6-astra")
        res = self.run_bin("models", "reset")
        self.assertEqual(res.returncode, 0, res.stderr)
        default = self.run_bin("models", "show", "--default").stdout
        self.assertEqual(self.run_bin("models", "show").stdout, default)
        self.assertNotIn("astra", self.config()["models"])

    def test_reset_restores_browser_tester_to_terra(self):
        config = self.config()
        config["roles"]["browser-tester"] = "sol"
        (self.factory / "config.json").write_text(json.dumps(config))
        res = self.run_bin("models", "reset")
        self.assertEqual(res.returncode, 0, res.stderr)
        config = self.config()
        self.assertEqual(config["roles"]["browser-tester"], "terra")
        self.assertEqual(config["models"]["terra"], {
            "provider": "codex", "model": "gpt-6.1-terra", "options": {"reasoningEffort": "xhigh"},
        })


if __name__ == "__main__":
    unittest.main()
