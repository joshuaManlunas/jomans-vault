from contextlib import redirect_stderr, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


JOB_PATH = Path(__file__).resolve().parents[1] / "bin" / "job"
spec = spec_from_loader("factory_job_cost", SourceFileLoader("factory_job_cost", str(JOB_PATH)))
job = module_from_spec(spec)
spec.loader.exec_module(job)

CODEX_MODEL = "gpt-6.1-sol"
CLAUDE_MODEL = "claude-sonnet-5-5"
EARLY = {"input_tokens": 40000, "cached_input_tokens": 10000, "output_tokens": 5000}
FINAL = {"input_tokens": 150000, "cached_input_tokens": 50000, "cache_write_input_tokens": 20000,
         "output_tokens": 21500, "reasoning_output_tokens": 10000}


def user_message(text):
    return {"type": "event_msg", "payload": {"type": "item_completed", "item": {
        "type": "UserMessage", "content": [{"type": "text", "text": text}],
    }}}


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records))


class JobCostTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.codex = self.root / "codex"
        prices = {
            CODEX_MODEL: {"input": 2.0, "output": 10.0, "cache_read": 0.1, "cache_write_30m": 2.5},
            CLAUDE_MODEL: {"input": 2.0, "output": 10.0, "cache_read": 0.1,
                           "cache_write_5m": 2.5, "cache_write_1h": 4.0},
        }
        for patcher in (
            patch.object(job, "JOBS", self.root / "factory" / "jobs"),
            patch.dict("os.environ", {
                "CODEX_HOME": str(self.codex), "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
            }),
            patch.dict(job.CONFIG, {"prices_usd_per_mtok": prices}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        job.JOBS.mkdir(parents=True)
        self.job_id = "001-first"
        self.other_id = "002-second"
        self.header = f"Job: {self.job_id}. Job folder: {job.job_dir(self.job_id)}/."

    def write_codex(self, storage, session_id, messages, snapshots, model=CODEX_MODEL):
        records = [
            {"type": "session_meta", "payload": {"id": session_id, "originator": "T3 Code"}},
            {"type": "turn_context", "payload": {"model": model}},
            *messages,
        ]
        for snapshot in snapshots:
            records.append({"type": "event_msg", "payload": {"type": "token_count", "info": {
                "total_token_usage": snapshot, "last_token_usage": EARLY,
            }}})
        write_jsonl(self.codex / storage / f"rollout-{session_id}.jsonl", records)

    def test_cost_uses_one_cumulative_snapshot_for_the_matching_job(self):
        other_header = f"Job: {self.other_id}. Job folder: {job.job_dir(self.other_id)}/."
        self.write_codex("archived_sessions", "child", [
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                  "content": [{"text": other_header}]}},
            user_message(f"Work on this job.\n\n{self.header}\nSee also:\n{other_header}"),
        ], [EARLY, FINAL, FINAL, EARLY])

        # Uncached input $0.16, cache reads $0.005, cache writes $0.05, output $0.215.
        self.assertEqual(job.cost_usd({"id": self.job_id}), 0.43)
        self.assertEqual(job.cost_usd({"id": self.other_id}), 0.0)

    def test_cost_keeps_the_largest_copy_of_a_session_and_ignores_later_prompts(self):
        messages = [user_message(self.header)]
        self.write_codex("sessions/2026/11/15", "same", messages, [EARLY])
        self.write_codex("archived_sessions", "same", messages, [EARLY, FINAL])
        self.write_codex("sessions/2026/11/15", "orchestrator", [
            user_message("Run the factory"), user_message(self.header),
        ], [FINAL])

        self.assertEqual(job.cost_usd({"id": self.job_id}), 0.43)

    def test_repeated_cost_checks_reuse_unchanged_rollouts(self):
        self.write_codex("archived_sessions", "child", [user_message(self.header)], [FINAL])
        self.write_codex("archived_sessions", "unrelated", [user_message("Other work")], [FINAL])

        with patch.object(job, "codex_rollout", wraps=job.codex_rollout) as parse:
            self.assertEqual(job.cost_usd({"id": self.job_id}), 0.43)
            self.assertEqual(parse.call_count, 2)
            self.assertEqual(job.cost_usd({"id": self.job_id}), 0.43)
            self.assertEqual(parse.call_count, 2)

    def test_cost_rereads_a_rollout_that_grows(self):
        self.write_codex("sessions", "child", [user_message(self.header)], [EARLY])
        self.write_codex("archived_sessions", "unrelated", [user_message("Other work")], [FINAL])
        self.assertEqual(job.cost_usd({"id": self.job_id}), 0.11)

        path = self.codex / "sessions" / "rollout-child.jsonl"
        with path.open("a") as f:
            f.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count",
                    "info": {"total_token_usage": FINAL}}}) + "\n")

        with patch.object(job, "codex_rollout", wraps=job.codex_rollout) as parse:
            self.assertEqual(job.cost_usd({"id": self.job_id}), 0.43)
            parse.assert_called_once_with(path)

    def test_summary_adds_claude_and_codex(self):
        write_jsonl(job.transcripts_dir() / "claude-child.jsonl", [
            {"type": "user", "message": {"content": self.header}},
            {"type": "assistant", "message": {"id": "reply", "model": CLAUDE_MODEL,
                                            "usage": {"input_tokens": 100000, "output_tokens": 10000}}},
        ])
        self.write_codex("sessions/2026/11/15", "codex-child", [
            {"type": "event_msg", "payload": {"type": "user_message", "message": self.header}},
        ], [EARLY, FINAL])
        folder = job.job_dir(self.job_id)
        folder.mkdir(parents=True)
        (folder / "job.json").write_text(json.dumps({
            "id": self.job_id, "issue": 1, "stage": "merged", "round": 0, "pr": 3,
            "started": "2026-11-15T10:00:00Z", "ended": "2026-11-15T10:30:00Z",
        }))

        with redirect_stdout(StringIO()) as output:
            job.cmd_summary([])
        self.assertIn("total $0.73 (API-equivalent, Claude + Codex factory agents)",
                      output.getvalue())

    def test_unpriced_model_reports_which_rate_is_missing(self):
        self.write_codex("archived_sessions", "new-model", [user_message(self.header)],
                         [FINAL], model="unpriced-model")
        with redirect_stderr(StringIO()) as output, self.assertRaises(SystemExit) as raised:
            job.cost_usd({"id": self.job_id})
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("no price for model unpriced-model in factory/config.json prices_usd_per_mtok",
                      output.getvalue())
