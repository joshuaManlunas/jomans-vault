import json
from pathlib import Path
import unittest


CONFIG = json.loads((Path(__file__).resolve().parents[1] / "config.json").read_text())


class RoutingTests(unittest.TestCase):
    def test_no_reviewer_is_routed_to_haiku(self):
        # Haiku reviewers raised findings the far larger builder rightly disputed.
        tables = list(CONFIG["routing"].values()) + list(CONFIG["surface_reviewers"].values())
        for table in tables:
            for reviewer, name in table.items():
                with self.subTest(reviewer=reviewer, model=name):
                    self.assertNotIn("haiku", CONFIG["models"][name]["model"])


if __name__ == "__main__":
    unittest.main()
