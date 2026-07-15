"""
comb rule-store server — Supabase Postgres backend.

Same API as the SQLite version, different storage. Connects directly to
Postgres (not through PostgREST) using the connection string from your
Supabase dashboard: Settings > Database > Connection string > URI.

That connection string has your DB password in it — set it as an env var,
never hardcode it here:

    export SUPABASE_DB_URL="postgresql://postgres:[password]@db.qkwkakxlyjtgcwahqndq.supabase.co:5432/postgres"

This connects as the `postgres` role, which bypasses RLS by design (RLS on
the `rules`/`misses` tables matters for anon/authenticated access via
Supabase's REST API or client SDKs — not for this server, which is the only
thing that ever touches the DB directly). Nothing outside this server should
hold SUPABASE_DB_URL.

Run:
    uvicorn comb_rule_server_supabase:app --host 0.0.0.0 --port 8420

Deps: fastapi, uvicorn, psycopg2-binary
    pip install fastapi uvicorn psycopg2-binary --break-system-packages
"""

import os
import re
import time
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

DB_URL = os.environ["SUPABASE_DB_URL"]  # fail loudly on startup if unset, don't silently fall back
CONFIDENCE_FLOOR = 0.2
CONFIDENCE_DECAY = 0.7
CONFIDENCE_GROWTH = 1.05

app = FastAPI(title="comb-rule-store (supabase)")


@contextmanager
def db():
    con = psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield con
        con.commit()
    finally:
        con.close()


# --- schemas (unchanged from the SQLite version) ---

class RuleIn(BaseModel):
    id: str
    trigger_regex: str
    keep_patterns: list[str] = []
    strip_patterns: list[str] = []
    keep_first_n: int = 5
    keep_last_n: int = 20
    max_lines: int | None = None
    status: str = "active"


class CompressRequest(BaseModel):
    command: str
    output: str


class CompressResponse(BaseModel):
    output: str
    rule_id: str | None


class ComplainRequest(BaseModel):
    rule_id: str


# --- helpers ---

def _row_to_rule(row: dict) -> dict:
    return {
        "id": row["id"],
        "trigger_regex": row["trigger_regex"],
        "keep_patterns": row["keep_patterns"].splitlines() if row["keep_patterns"] else [],
        "strip_patterns": row["strip_patterns"].splitlines() if row["strip_patterns"] else [],
        "keep_first_n": row["keep_first_n"],
        "keep_last_n": row["keep_last_n"],
        "max_lines": row["max_lines"],
        "confidence": row["confidence"],
        "uses": row["uses"],
        "complaints": row["complaints"],
        "last_used": row["last_used"],
        "status": row["status"],
    }


def _looks_critical(output: str) -> bool:
    markers = (
        r"\bTraceback \(most recent call last\)",
        r"\bError\b", r"\bFAILED\b", r"\bException\b",
        r"^\s*File \".*\", line \d+",
    )
    return any(re.search(m, output, re.MULTILINE) for m in markers)


# --- endpoints ---

@app.post("/rules")
def register_rule(rule: RuleIn):
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT id FROM rules WHERE id = %s", (rule.id,))
        if cur.fetchone():
            return {"status": "exists"}
        cur.execute(
            """INSERT INTO rules
               (id, trigger_regex, keep_patterns, strip_patterns,
                keep_first_n, keep_last_n, max_lines, status)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (rule.id, rule.trigger_regex,
             "\n".join(rule.keep_patterns), "\n".join(rule.strip_patterns),
             rule.keep_first_n, rule.keep_last_n, rule.max_lines, rule.status),
        )
    return {"status": "created"}


@app.post("/rules/{rule_id}/approve")
def approve_candidate(rule_id: str):
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT id FROM rules WHERE id = %s", (rule_id,))
        if cur.fetchone() is None:
            raise HTTPException(404, f"no such rule: {rule_id}")
        cur.execute("UPDATE rules SET status = 'active' WHERE id = %s", (rule_id,))
    return {"status": "approved"}


@app.get("/rules/candidates")
def list_candidates():
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM rules WHERE status = 'candidate'")
        rows = cur.fetchall()
    return [_row_to_rule(r) for r in rows]


@app.get("/rules")
def list_rules():
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM rules ORDER BY uses DESC")
        rows = cur.fetchall()
    return [_row_to_rule(r) for r in rows]


@app.get("/misses")
def list_misses(since: float = 0.0, limit: int = 500):
    with db() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM misses WHERE ts > %s ORDER BY ts DESC LIMIT %s",
            (since, limit),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/compress", response_model=CompressResponse)
def compress(req: CompressRequest):
    if _looks_critical(req.output):
        return CompressResponse(output=req.output, rule_id=None)

    with db() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM rules WHERE confidence >= %s AND status = 'active'",
            (CONFIDENCE_FLOOR,),
        )
        rows = cur.fetchall()
        rule = next((r for r in rows if re.search(r["trigger_regex"], req.command)), None)

        if rule is None:
            lines = req.output.splitlines()
            cur.execute(
                "INSERT INTO misses (command, output_sample, line_count, ts) VALUES (%s, %s, %s, %s)",
                (req.command, req.output[:2000], len(lines), time.time()),
            )
            return CompressResponse(output=req.output, rule_id=None)

        lines = req.output.splitlines()
        if rule["max_lines"] and len(lines) <= rule["max_lines"]:
            return CompressResponse(output=req.output, rule_id=None)

        keep_first, keep_last = rule["keep_first_n"], rule["keep_last_n"]
        keep_patterns = rule["keep_patterns"].splitlines() if rule["keep_patterns"] else []
        strip_patterns = rule["strip_patterns"].splitlines() if rule["strip_patterns"] else []

        kept = set(range(min(keep_first, len(lines))))
        kept |= set(range(max(0, len(lines) - keep_last), len(lines)))
        for i, line in enumerate(lines):
            if any(re.search(p, line) for p in keep_patterns):
                kept.add(i)

        compressed = [
            line for i, line in enumerate(lines)
            if i in kept or not any(re.search(p, line) for p in strip_patterns)
        ]
        if len(compressed) < len(lines):
            compressed.insert(
                keep_first,
                f"... [comb: {len(lines) - len(compressed)} lines pruned by rule '{rule['id']}'] ..."
            )

        new_conf = min(1.0, rule["confidence"] * CONFIDENCE_GROWTH)
        cur.execute(
            "UPDATE rules SET uses = uses + 1, confidence = %s, last_used = %s WHERE id = %s",
            (new_conf, time.time(), rule["id"]),
        )

    return CompressResponse(output="\n".join(compressed), rule_id=rule["id"])


@app.post("/complain")
def complain(req: ComplainRequest):
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT confidence FROM rules WHERE id = %s", (req.rule_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(404, f"no such rule: {req.rule_id}")
        cur.execute(
            "UPDATE rules SET confidence = %s, complaints = complaints + 1 WHERE id = %s",
            (row["confidence"] * CONFIDENCE_DECAY, req.rule_id),
        )
    return {"status": "ok"}


@app.get("/health")
def health():
    try:
        with db() as con:
            con.cursor().execute("SELECT 1")
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "degraded", "db": str(e)}
