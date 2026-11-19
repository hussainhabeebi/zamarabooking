"""Tests for check-release-workflow-modes.py: the real workflow passes; unsafe edits are caught.

Run: python3 -m unittest scripts/test_check_release_workflow_modes.py
"""
import importlib.util
import pathlib
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/release-search-analytics.yml"
spec = importlib.util.spec_from_file_location("checker", ROOT / "scripts/check-release-workflow-modes.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def load(text=None):
    return yaml.safe_load(text if text is not None else WORKFLOW.read_text())


class ReleaseWorkflowModes(unittest.TestCase):
    def test_real_workflow_is_safe(self):
        self.assertEqual(checker.problems(load()), [])

    def test_default_mode_is_validate(self):
        mode = load()[True]["workflow_dispatch"]["inputs"]["mode"]
        self.assertEqual(mode["default"], "validate")
        self.assertIn("validate", mode["options"])

    def test_validate_jobs_never_migrate_or_deploy(self):
        jobs = load()["jobs"]
        for name in ("migrate", "deploy-api", "deploy-admin", "verify-off", "rollback", "drop-analytics-tables", "release-report"):
            self.assertNotIn("validate", str(jobs[name].get("if", "")), name)
        for name in ("live-check", "test-admin", "validation-report"):
            self.assertEqual(str(jobs[name]["if"]).count("inputs.mode == 'validate'"), 1, name)

    def test_backup_sessions_are_read_only(self):
        jobs = load()["jobs"]
        for name in ("backup", "live-check"):
            self.assertIn("default_transaction_read_only=on", jobs[name]["env"]["PGOPTIONS"], name)

    def test_migrate_reachable_from_validate_is_caught(self):
        text = WORKFLOW.read_text().replace(
            "    name: Apply migration 0015 only (two new analytics tables)\n    needs: [test, backup]\n    if: inputs.mode == 'deploy' && inputs.components != 'admin'",
            "    name: Apply migration 0015 only (two new analytics tables)\n    needs: [test, backup]\n    if: inputs.mode == 'deploy' || inputs.mode == 'validate'")
        self.assertNotEqual(text, WORKFLOW.read_text())
        self.assertTrue(any("'migrate'" in p for p in checker.problems(load(text))))

    def test_deploy_step_added_to_validate_job_is_caught(self):
        doc = load()
        doc["jobs"]["live-check"]["steps"].append({"run": "pnpm exec wrangler deploy --message x"})
        self.assertTrue(any("'live-check'" in p for p in checker.problems(doc)))

    def test_kv_write_and_sql_write_are_caught(self):
        for cmd in ('pnpm exec wrangler kv key put admin_settings:x:analytics \'{"searchTracking":true}\'',
                    'psql "$U" -tAc "UPDATE bookings SET status = 1"',
                    'pg_restore --dbname "$DATABASE_URL" db.dump'):
            doc = load()
            doc["jobs"]["live-check"]["steps"].append({"run": cmd})
            self.assertTrue(checker.problems(doc), cmd)

    def test_push_trigger_is_caught(self):
        doc = load()
        doc[True]["push"] = {"branches": ["main"]}
        self.assertTrue(any("workflow_dispatch only" in p for p in checker.problems(doc)))


if __name__ == "__main__":
    unittest.main()
