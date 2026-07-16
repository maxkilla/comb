-- comb rule-store schema (Supabase Postgres)
--
-- Idempotent: safe to run on a cold project or re-run. Mirrors the exact
-- tables the server (comb_rule_server_supabase.py) and seed
-- (seed_rules_supabase.py) assume. `created_at` is included because the
-- running DB has it; the server's SELECT * tolerates it and the seed's
-- explicit-column INSERTs don't touch it (defaults to now()).
--
-- Apply one of:
--   psql "$SUPABASE_DB_URL" -f schema_supabase.sql
-- or let seed_rules_supabase.py run it for you (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS rules (
    id             TEXT    PRIMARY KEY,
    trigger_regex  TEXT    NOT NULL,
    keep_patterns  TEXT    NOT NULL DEFAULT '',
    strip_patterns TEXT    NOT NULL DEFAULT '',
    keep_first_n   INTEGER NOT NULL DEFAULT 5,
    keep_last_n    INTEGER NOT NULL DEFAULT 20,
    max_lines      INTEGER,
    confidence     REAL    NOT NULL DEFAULT 1.0,
    uses           INTEGER NOT NULL DEFAULT 0,
    complaints     INTEGER NOT NULL DEFAULT 0,
    last_used      DOUBLE PRECISION NOT NULL DEFAULT 0,
    status         TEXT    NOT NULL DEFAULT 'active',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS misses (
    id            BIGSERIAL PRIMARY KEY,
    command       TEXT    NOT NULL,
    output_sample TEXT    NOT NULL,
    line_count    INTEGER NOT NULL,
    ts            DOUBLE PRECISION NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
