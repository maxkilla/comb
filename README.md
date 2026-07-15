# comb

Minimal code AND minimal words, combined. Two blades: what you build, how you talk about it.

- **Blade 1 — code:** an efficiency ladder (YAGNI → reuse → stdlib → native → existing dep → one line → minimum code). Stop at the first rung that holds.
- **Blade 2 — prose:** facts and code, no preamble, no restating the ask, no trailing summary. Fragments over sentences where meaning survives.

Trigger words: "comb", "comb mode", "be lazy", "keep it short", "yagni", "minimal", "no fluff", or complaining about over-engineering/bloat/long-winded answers. Off: "stop comb" / "normal mode". One blade only: "comb code" or "comb prose".

Full rules: [`skills/comb/SKILL.md`](skills/comb/SKILL.md).

Supports Claude Code and Hermes — the two agents this was built for, both of which support the full feature set (persona skill + tool-output compression hook).

## What's in this repo

| Piece | Where |
|---|---|
| Claude Code skill (source of truth) | `skills/comb/SKILL.md` |
| Claude Code plugin manifest | `.claude-plugin/` |
| Claude Code compression hook | `hooks/hooks.json` + `scripts/compress-tool-output.js` |
| Hermes skill | `skills/comb/SKILL.hermes.md` |
| Hermes compression plugin | `plugin.yaml` + `__init__.py` (repo root) |
| Rule-store backend (Supabase) | `comb_rule_server_supabase.py` |
| Rule-store seed script | `seed_rules_supabase.py` |
| Benchmark vs rdxmin | `benchmarks/vs-rdxmin.js` |
| Tests | `test/compress.test.js`, `test/test_compress.py` |

The persona rules are the same content in both. The tool-output compressor (elides oversized Bash/Agent/WebFetch/WebSearch/Grep/Glob/MCP output, keeps head/tail/error lines) is ported to both hosts' equivalent hook point — Claude Code's `PostToolUse` and Hermes' `transform_tool_result`.

**Optional rule-store.** Both ports can offload compression to an external rule-store server *before* falling back to generic elision. The production backend is `comb_rule_server_supabase.py` (FastAPI + psycopg2), which stores rules and misses in Supabase Postgres. When `COMB_RULE_STORE_URL` is unset, comb is zero-dependency and zero-network — the rule-store path is fully skipped.

If a middle section has more distinct error-looking lines than the compressor can salvage (`MAX_ERROR_LINES`, 15), it leaves the output whole instead of guessing which errors to drop — a critical-gate pattern from [TACO](https://www.alphaxiv.org/abs/2604.19572) (arXiv:2604.19572), adapted here as a static rule rather than their self-evolving one. That full bypass only applies below `GATE_MAX_CHARS` (20000 chars) — above it, a dense-error output still needs elision, so it falls back to the normal salvage cap instead of passing an arbitrarily large blob through untouched. The rule-store server also passes critical-looking output (Traceback/Error/FAILED) through untouched.

## Install

**Claude Code (plugin):**
```bash
claude plugin marketplace add maxkilla/comb
claude plugin install comb@comb
```

**Hermes:**
```bash
hermes plugins install maxkilla/comb --enable
```
(Or manual: `cp plugin.yaml __init__.py ~/.hermes/plugins/comb/` then add `comb` to `plugins.enabled`.)
The persona skill is separate — copy `skills/comb/SKILL.hermes.md` to `~/.hermes/skills/software-development/comb/SKILL.md` if you want comb mode.
```yaml
plugins:
  enabled:
    - comb
```
Plugin's `kind` is omitted in `plugin.yaml` — Hermes defaults that to `standalone`, which is what makes the `enabled` list opt-in required. (Project-local install: `./comb/`, requires `HERMES_ENABLE_PROJECT_PLUGINS=1`.)

## Tool-output compressor tuning (Claude Code + Hermes)

Env vars, both ports:
```
COMB_COMPRESS_HEAD       # chars kept from the start (default 1200)
COMB_COMPRESS_TAIL       # chars kept from the end (default 800)
COMB_COMPRESS_THRESHOLD  # only compress above this size (default 3000)
COMB_COMPRESS_GATE_MAX   # size ceiling for the error-count full-bypass gate (default 20000)
COMB_COMPRESS=0          # kill switch (Hermes only; 0/false/no/off) — disables without touching config.yaml
COMB_RULE_STORE_URL      # opt-in: http[s]://host:port of the rule-store server; unset = skip rule-store
COMB_RULE_STORE_TIMEOUT_MS  # rule-store request timeout (default 500; never blocks the hook)
```

Rule-store server env vars (set where `comb_rule_server_supabase.py` runs):
```
SUPABASE_DB_URL         # required: postgres connection string (role bypasses RLS; only the server holds this)
COMB_RULES_TTL_SEC      # rules cache TTL before a lazy refresh (default 30)
COMB_RULES_REFRESH_SEC  # background refresher interval (default 15; rule changes propagate within this window)
```

## Rule-store (Supabase) — optional

Both compressor ports can POST `{command, output}` to `${COMB_RULE_STORE_URL}/compress` and
get back `{output, rule_id}`. If the server returns no rule, times out, errors, or returns
output unchanged, the hook falls back to generic elision. Fail-open: the rule-store can never
slow or break the hot path.

The production backend (`comb_rule_server_supabase.py`, FastAPI + psycopg2) stores rules and
misses in Supabase Postgres. It connects as the `postgres` role (bypasses RLS; only this server
holds `SUPABASE_DB_URL`). Critical-looking output is passed through untouched.

**Run the server:**
```bash
export SUPABASE_DB_URL="postgresql://postgres.<ref>:***@aws-0-<region>.pooler.supabase.com:6543/postgres"
pip install fastapi uvicorn psycopg2-binary --break-system-packages
uvicorn comb_rule_server_supabase:app --host 127.0.0.1 --port 8420
```

**Seed the rules** (idempotent — safe to re-run):
```bash
export SUPABASE_DB_URL="postgresql://postgres.<ref>:***@aws-0-<region>.pooler.supabase.com:6543/postgres"
python3 seed_rules_supabase.py
```
Ships three firing rules: `pytest_verbose` (drops per-test `PASSED [n%]` noise, keeps failures +
summary), `npm_install` (drops `npm warn` advisory spam, keeps errors + the `added N packages`
summary), and `git_diff` (drops unchanged context lines, keeps file/`@@` headers + `+`/`-`
changes). A rule only compresses if its keep/strip patterns actually reduce the output — a rule
that matches the command but keeps every line is a no-op (the hook sees `output === input` and
falls back to generic elision).

**Wire into comb:** set `COMB_RULE_STORE_URL=http://127.0.0.1:8420` in the compressor's
environment (e.g. `/etc/comb/cron_env`). The Hermes plugin sources `/etc/comb/env` (secrets like
`SUPABASE_DB_URL`) and `/etc/comb/cron_env` (settings like `COMB_RULE_STORE_URL`) at import time.

**In-memory rules cache.** The server matches against a rules cache, not a live Supabase query, on
the hot path. The cache is primed at startup and refreshed by a background thread every
`COMB_RULES_REFRESH_SEC` (default 15s; lazy TTL fallback `COMB_RULES_TTL_SEC` = 30s). This takes
the per-call Supabase round-trip off `/compress`: measured rule-match latency through the live
comb hook dropped from ~48 ms/call (1 query per call) to **~6–9 ms/call** — a ~5–8× speedup — with
compression ratio unchanged. Stats writes (`uses`/`confidence` on a match, `misses` on a no-match)
are fire-and-forget background threads so they never block the response.

Cache coherence: a rule added or approved via the control plane (`/rules`, `/rules/{id}/approve`)
takes effect on the **very next** `/compress` call — a cache miss triggers one fresh DB pull, so
there's no stale window for the write paths. The background refresher is the steady-state
warm-up, not the only propagation mechanism. A failed refresh keeps the last good cache
(stale-but-working beats empty). Tune `COMB_RULES_REFRESH_SEC` only if you want a tighter bound on
how quickly *deleted* (vs added/approved) rules stop matching — deletions still wait for the next
refresh.

**Misses** (unmatched commands) are logged to the `misses` table — a feed for discovering new
rules. Endpoints: `/compress`, `/rules`, `/rules/{id}/approve`, `/rules/candidates`, `/misses`,
`/complain`, `/health`.

## Benchmark

`benchmarks/vs-rdxmin.js` replays your real Claude Code transcripts through both comb's and rdxmin's compression code — deterministic, zero LLM calls:

```bash
node benchmarks/vs-rdxmin.js
```

## Test

```bash
npm test                       # Claude Code compressor (scripts/compress-tool-output.js)
python3 test/test_compress.py  # Hermes plugin (comb/__init__.py)
```

## License

MIT — see [LICENSE](LICENSE).
