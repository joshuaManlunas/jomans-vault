import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROUTE = Path(__file__).resolve().parents[1] / "bin" / "route"


class BrowserConfigTests(unittest.TestCase):
    def test_route_prints_browser_settings_without_environment_values(self):
        browser = {"cli": "browser-for-tests", "setup": "browser-for-tests setup"}
        account = {"email_env": "REVIEW_EMAIL", "password_env": "REVIEW_PASSWORD", "seed": "seed-reviewer"}
        credentials = {"REVIEW_EMAIL": "reviewer@example.invalid", "REVIEW_PASSWORD": "test-only-password"}
        signed_out = {"browser": browser, "review_account": None}
        signed_in = {"browser": browser, "review_account": account}

        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            (factory / "bin").mkdir()
            route = shutil.copy(ROUTE, factory / "bin" / "route")
            for label, config, expected in (
                ("absent", {}, {"browser": None, "review_account": None}),
                ("null", signed_out, signed_out),
                ("configured", signed_in, signed_in),
            ):
                with self.subTest(label=label):
                    (factory / "config.json").write_text(json.dumps(config))
                    result = subprocess.run([route, "--browser"], text=True, capture_output=True,
                                            env=os.environ | credentials)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), expected)
                    for value in credentials.values():
                        self.assertNotIn(value, result.stdout + result.stderr)
