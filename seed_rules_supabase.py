#!/usr/bin/env python3
"""Seed comb's Supabase rule-store with real, firing rules.

Idempotent: uses INSERT ... ON CONFLICT DO UPDATE so re-running is safe.
A rule only "fires" (compresses) if its keep/strip patterns actually reduce
the output; rules with empty strip_patterns keep everything and are no-ops.

Run after SUPABASE_DB_URL is set (sourced from /etc/comb/env by the
comb-rule-store systemd service, or export it manually):

    export SUPABASE_DB_URL="postgresql://postgres.<ref>:...@aws-0-<region>...:6543/postgres"
    python3 seed_rules_supabase.py
"""
import os
import sys
import psycopg2

DSN = os.environ.get("SUPABASE_DB_URL")
if not DSN:
    # best-effort: read from /etc/comb/env
    try:
        for line in open("/etc/comb/env"):
            line = line.strip()
            if line.startswith("SUPABASE_DB_URL="):
                DSN = line.split("=", 1)[1].split("#")[0].strip()
    except FileNotFoundError:
        pass
if not DSN:
    sys.exit("SUPABASE_DB_URL not set and /etc/comb/env missing it")

# Each rule: id, trigger_regex, keep_patterns (\\n-separated), strip_patterns,
# keep_first_n, keep_last_n, max_lines, status.
RULES = [
    # pytest -v / -vv: keep the summary + any failures, strip the per-test
    # PASSED [nn%] / deselected / slowest lines that dominate long runs.
    (
        "pytest_verbose",
        r"\bpytest\b",
        "FAILED\nERROR\npassed\nfailed\nerror\n=====",
        "^.* PASSED \\[.*\\]\n^deselected\n^ slowest \\d+ durations",
        8,    # keep first 8 (summary header / collection)
        20,   # keep last 20 (final summary block)
        None,
        "active",
    ),
    # npm install / ci: keep errors + the "added N packages" summary line,
    # strip the wall of "npm warn ..." advisory noise.
    (
        "npm_install",
        r"\bnpm (install|ci|add|update)\b",
        "npm error\nnpm ERR\nadded \\d+ package",
        "^npm warn ",
        3,
        3,     # keep last 3: covers "added N packages" / "audited" / "vulnerabilities" tail
        None,  # max_lines None = always consider
        "active",
    ),
    # git diff: keep the file headers + @@ hunk headers + any +/- change
    # lines, strip unchanged context lines (the bulk of a big diff).
    (
        "git_diff",
        r"\bgit diff\b",
        "^diff --git\n^index \n^@@ \n^\\+",
        "^ ",  # context lines start with a single space
        4,
        4,
        None,
        "active",
    ),
]

con = psycopg2.connect(DSN, connect_timeout=10)
con.autocommit = True
cur = con.cursor()
for rid, trig, keep, strip, kf, kl, ml, status in RULES:
    cur.execute(
        """INSERT INTO rules
           (id, trigger_regex, keep_patterns, strip_patterns,
            keep_first_n, keep_last_n, max_lines, status)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET
             trigger_regex = EXCLUDED.trigger_regex,
             keep_patterns = EXCLUDED.keep_patterns,
             strip_patterns = EXCLUDED.strip_patterns,
             keep_first_n  = EXCLUDED.keep_first_n,
             keep_last_n   = EXCLUDED.keep_last_n,
             max_lines     = EXCLUDED.max_lines,
             status        = EXCLUDED.status,
             confidence    = 1.0""",
        (rid, trig, keep, strip, kf, kl, ml, status),
    )
    print(f"seeded {rid}")

cur.execute("SELECT id, keep_first_n, keep_last_n, keep_patterns, strip_patterns, status FROM rules ORDER BY id")
for r in cur.fetchall():
    print("  ", r)
con.close()
print("done")
