#!/usr/bin/env python3
"""Integration tests for the comb rule-store server's cache coherence.

These exercise the REAL server (HTTP + Supabase), so they only run when a
live rule-store is reachable. Skipped automatically otherwise (e.g. in CI
without COMB_RULE_STORE_URL / SUPABASE_DB_URL). Run locally with:

    COMB_RULE_STORE_URL=http://127.0.0.1:8420 python3 test/server_cache_test.py

They lock in the cache contract documented in the README:
  - a rule added via the DB takes effect on the NEXT /compress call
    (cache miss triggers a fresh pull -- no 15s stale window)
  - a candidate approved via /rules/{id}/approve takes effect on the next call
  - a deleted rule keeps matching until the background refresh, then stops
    (deletions wait for RULES_REFRESH_SEC, by design)
"""
import os
import time
import unittest
import json
import urllib.request
import urllib.error

try:
    import psycopg2
except ImportError:
    psycopg2 = None

BASE = os.environ.get("COMB_RULE_STORE_URL", "").rstrip("/")
DSN = os.environ.get("SUPABASE_DB_URL")
if not DSN:  # best-effort: read from /etc/comb/env
    try:
        for line in open("/etc/comb/env"):
            line = line.strip()
            if line.startswith("SUPABASE_DB_URL="):
                DSN = line.split("=", 1)[1].split("#")[0].strip()
                break
    except FileNotFoundError:
        pass

SKIP = (not BASE) or (psycopg2 is None) or (not DSN)


def _post(path, payload=None, method="POST"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method=method,
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def _compress(command, output):
    return _post("/compress", {"command": command, "output": output})


def _db():
    return psycopg2.connect(DSN, connect_timeout=10)


@unittest.skipIf(SKIP, "live rule-store (COMB_RULE_STORE_URL + SUPABASE_DB_URL) not available")
class CacheCoherenceTest(unittest.TestCase):
    def setUp(self):
        self.con = _db()
        self.con.autocommit = True
        self.cur = self.con.cursor()
        # unique rule id per test method so tests can't collide on state
        self.rule_id = f"cache_coh_{self._testMethodName}"
        self.cur.execute("DELETE FROM rules WHERE id=%s", (self.rule_id,))
        self.con.commit()
        self.out = "\n".join(["START"] + [f"JUNK line {i}" for i in range(100)] + ["END"])

    def tearDown(self):
        self.cur.execute("DELETE FROM rules WHERE id=%s", (self.rule_id,))
        self.con.commit()
        self.con.close()

    def _insert(self, status="active"):
        self.cur.execute(
            "INSERT INTO rules (id, trigger_regex, keep_patterns, strip_patterns, "
            "keep_first_n, keep_last_n, max_lines, status) VALUES (%s,%s,'','^JUNK',2,2,NULL,%s) "
            "ON CONFLICT (id) DO UPDATE SET status=%s, confidence=1.0, strip_patterns='^JUNK'",
            (self.rule_id, r"\b" + self.rule_id + r"\b", status, status),
        )
        self.con.commit()

    def test_add_takes_effect_on_next_call(self):
        # cache is warm (server running) but rule absent -> insert, then the
        # very next /compress must fire (cache-miss refresh, no 15s wait).
        self.assertIsNone(_compress(self.rule_id, self.out)["rule_id"])
        self._insert("active")
        j = _compress(self.rule_id, self.out)
        self.assertEqual(j["rule_id"], self.rule_id)
        self.assertIn("pruned by rule", j["output"])

    def test_approve_takes_effect_on_next_call(self):
        self._insert("candidate")  # only 'active' rules match
        self.assertIsNone(_compress(self.rule_id, self.out)["rule_id"])
        _post(f"/rules/{self.rule_id}/approve")
        j = _compress(self.rule_id, self.out)
        self.assertEqual(j["rule_id"], self.rule_id)

    def test_delete_waits_for_refresh(self):
        self._insert("active")
        # warm into cache
        self.assertEqual(_compress(self.rule_id, self.out)["rule_id"], self.rule_id)
        # delete directly; cache still warm so it keeps matching immediately
        self.cur.execute("DELETE FROM rules WHERE id=%s", (self.rule_id,))
        self.con.commit()
        self.assertEqual(_compress(self.rule_id, self.out)["rule_id"], self.rule_id)
        # after the background refresh it must stop
        time.sleep(float(os.environ.get("COMB_RULES_REFRESH_SEC", "15")) + 3)
        self.assertIsNone(_compress(self.rule_id, self.out)["rule_id"])


if __name__ == "__main__":
    unittest.main()
