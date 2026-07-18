# comb

Minimal code AND minimal words, combined. Two blades: what you build, how you talk about it.

- **Blade 1 — code:** an efficiency ladder (YAGNI → reuse → stdlib → native → existing dep → one line → minimum code). Stop at the first rung that holds.
- **Blade 2 — prose:** facts and code, no preamble, no restating the ask, no trailing summary. Fragments over sentences where meaning survives.

Default-on, no trigger word needed — see "Always-on persona" below. Off: "stop comb" / "normal mode". One blade only: "comb code" or "comb prose".

Full rules: [`skills/comb/SKILL.md`](skills/comb/SKILL.md).

Supports Claude Code and Hermes — the two agents this was built for, both of which support the full feature set (persona skill + tool-output compression hook).

## What's in this repo

| Piece | Where |
|---|---|
| Claude Code skill (source of truth) | `skills/comb/SKILL.md` |
| Claude Code plugin manifest | `.claude-plugin/` |
| Claude Code compression hook | `hooks/hooks.json` + `scripts/compress-tool-output.js` |
| Claude Code always-on persona hook | `hooks/hooks.json` + `scripts/inject-comb-mode.js` |
| Hermes skill | `skills/comb/SKILL.hermes.md` |
| Hermes compression plugin | `plugin.yaml` + `__init__.py` (repo root) |
| Benchmark vs rdxmin | `benchmarks/vs-rdxmin.js` |
| Tests | `test/compress.test.js`, `test/test_compress.py` |

The persona rules are the same content in both. The tool-output compressor (elides oversized Bash/Agent/WebFetch/WebSearch/Grep/Glob/MCP output, keeps head/tail/error lines) is ported to both hosts' equivalent hook point — Claude Code's `PostToolUse` and Hermes' `transform_tool_result`. Deterministic, zero-dependency, zero-network — no external service required.

If a middle section has more distinct error-looking lines than the compressor can salvage (`MAX_ERROR_LINES`, 15), it leaves the output whole instead of guessing which errors to drop — a critical-gate pattern from [TACO](https://www.alphaxiv.org/abs/2604.19572) (arXiv:2604.19572), adapted here as a static rule rather than their self-evolving one. That full bypass only applies below `GATE_MAX_CHARS` (20000 chars) — above it, a dense-error output still needs elision, so it falls back to the normal salvage cap instead of passing an arbitrarily large blob through untouched.

## Always-on persona

Comb doesn't wait for the model to notice a trigger word or choose to load a skill:

- **Claude Code:** the plugin's `UserPromptSubmit` hook (`scripts/inject-comb-mode.js`) injects the persona rules as `additionalContext` on every turn.
- **Hermes:** installed by appending the same rules to `~/.hermes/SOUL.md`, the agent's identity slot — loaded unconditionally every session, no skill load required. (This edits a file outside the repo; if you don't want that, delete the appended block from `SOUL.md` and rely on `skills/comb/SKILL.hermes.md` instead, trigger-word activated.)

Either way, `skills/comb/SKILL.md` / `SKILL.hermes.md` stay as the source of truth and remain independently loadable.

## Statusline (Claude Code)

`scripts/comb-statusline.sh` renders a `[COMB]` badge showing rate-limit usage (5h/weekly bars, same data `/usage` shows) and cumulative compressor savings (`⇣NNk tok (Nx)`, read from `~/.claude/comb/stats.json`, written by `compress-tool-output.js` on every elision). Bash-only, no jq/node dependency, symlink-refused reads.

Claude Code allows exactly one `statusLine` command — wire it in `~/.claude/settings.json`:
```json
"statusLine": {
  "type": "command",
  "command": "bash \"/absolute/path/to/comb/scripts/comb-statusline.sh\""
}
```

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
COMB_COMPRESS_SAVE_FULL=0  # Claude Code only: disable saving the full untouched output to disk on elision
```

**Elided output recovery (Claude Code only).** Elision is otherwise irreversible, so by default
(`COMB_COMPRESS_SAVE_FULL` unset or `1`) the full original text is saved to
`~/.claude/comb/tool-output/` (mode `0600`, capped at 1MB per file, head75/tail25 if larger) and
the elided marker includes the recovery path. Files older than 7 days are swept opportunistically
(2% chance per save, no dedicated hot-path scan) rather than requiring a cron job. Since this
persists full tool output — including anything sensitive that appeared in it — to disk, set
`COMB_COMPRESS_SAVE_FULL=0` if you'd rather lose the recovery file than keep it around.

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
