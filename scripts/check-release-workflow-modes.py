#!/usr/bin/env python3
"""Safety check for release workflows that have a mode=validate.

Fails (exit 1) unless:
  - the workflow only runs on workflow_dispatch (never on push / schedule / PR);
  - every job that can change production (migrate, deploy, roll back, drop tables, change a
    secret / KV setting, delete from R2) has an `if:` that names a production mode
    (deploy, rollback or drop-analytics-tables) and does NOT mention `validate`;
  - every job whose `if:` mentions `validate` contains none of those commands.

Usage: check-release-workflow-modes.py <workflow.yml>
"""
import re
import sys

import yaml

# Commands that change production. Read-only commands (deployments list, kv key get/list,
# r2 object get, pg_dump, psql -c SELECT) are not listed.
DANGEROUS = [
    (r"wrangler\s+deploy\b", "deploys a Worker"),
    (r"wrangler\s+rollback\b", "rolls back a Worker"),
    (r"wrangler\s+versions\s+deploy\b", "deploys a Worker version"),
    (r"wrangler\s+secret\b", "changes a Worker secret"),
    (r"wrangler\s+kv\s+key\s+(put|delete)\b", "changes a KV setting"),
    (r"wrangler\s+kv\s+bulk\b", "changes KV settings"),
    (r"wrangler\s+r2\s+object\s+delete\b", "deletes from R2"),
    (r"wrangler\s+r2\s+bucket\s+(create|delete)\b", "changes an R2 bucket"),
    (r"psql\b[^\n]*\s-f\s", "runs an SQL file against a database"),
    (r"--single-transaction", "runs an SQL file against a database"),
    (r"\bdrizzle-kit\s+(migrate|push)\b", "migrates a database"),
    (r"\bdb:(migrate|push)\b", "migrates a database"),
    # pg_restore may only write into the runner's throwaway database ($LOCAL_URL).
    (r"pg_restore\s+(?![^\n]*--list)(?![^\n]*--dbname\s+\"\$LOCAL_URL\")-", "restores into a database other than the runner's throwaway one"),
]
PROD_MODES = ("'deploy'", "'rollback'", "'drop-analytics-tables'")
# SQL that writes, when it appears inside a psql -c / -tAc string.
SQL_WRITE = re.compile(r"""psql[^\n]*-[a-zA-Z]*c\s+["'][^"']*\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b""", re.I)


def job_text(job):
    return "\n".join(str(step.get("run", "")) for step in job.get("steps", []) or [])


def problems(doc):
    out = []
    on = doc.get("on", doc.get(True))  # PyYAML reads the key `on` as True
    triggers = set(on.keys()) if isinstance(on, dict) else {on} if isinstance(on, str) else set(on or [])
    if triggers != {"workflow_dispatch"}:
        out.append(f"workflow must run on workflow_dispatch only, found {sorted(map(str, triggers))}")
    for name, job in (doc.get("jobs") or {}).items():
        cond = str(job.get("if", ""))
        text = job_text(job)
        reasons = [why for rx, why in DANGEROUS if re.search(rx, text)]
        if SQL_WRITE.search(text):
            reasons.append("runs writing SQL")
        mentions_validate = "validate" in cond
        if reasons:
            if not any(f"inputs.mode == {m}" in cond for m in PROD_MODES):
                out.append(f"job '{name}' {', '.join(sorted(set(reasons)))} but its if: does not require a production mode: {cond!r}")
            if mentions_validate:
                out.append(f"job '{name}' {', '.join(sorted(set(reasons)))} and can run in mode=validate: {cond!r}")
    return out


def main(path):
    with open(path) as f:
        doc = yaml.safe_load(f)
    errs = problems(doc)
    for e in errs:
        print(f"::error::{e}")
    if errs:
        return 1
    print(f"{path}: every production-changing job is behind deploy / rollback / drop; validate cannot reach them.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
