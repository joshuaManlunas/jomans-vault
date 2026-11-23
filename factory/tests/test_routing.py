import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


FACTORY = Path(__file__).resolve().parents[1]
CONFIG = json.loads((FACTORY / "config.json").read_text())


class RoutingTests(unittest.TestCase):
    def test_escalation_categories(self):
        with tempfile.TemporaryDirectory(dir=FACTORY) as tmp:
            factory = Path(tmp)
            route = factory / "bin" / "route"
            route.parent.mkdir()
            shutil.copy2(FACTORY / "bin" / "route", route)
            for categories in (["public API changes", "billing changes"], [], None):
                with self.subTest(categories=categories):
                    expected = {"categories": categories or []}
                    config = {"escalate": expected} if categories is not None else {}
                    (factory / "config.json").write_text(json.dumps(config))
                    out = subprocess.check_output([str(route), "--escalate"], text=True)
                    self.assertEqual(json.loads(out), expected)

    def test_no_reviewer_is_routed_to_haiku(self):
        # Haiku reviewers raised findings the far larger builder rightly disputed.
        tables = list(CONFIG["routing"].values()) + list(CONFIG["surface_reviewers"].values())
        for table in tables:
            for reviewer, name in table.items():
                with self.subTest(reviewer=reviewer, model=name):
                    self.assertNotIn("haiku", CONFIG["models"][name]["model"])


if __name__ == "__main__":
    unittest.main()
