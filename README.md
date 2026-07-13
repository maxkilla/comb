# comb

Minimal code AND minimal words, combined. Two blades: what you build, how you talk about it.

- **Blade 1 — code:** an efficiency ladder (YAGNI → reuse → stdlib → native → existing dep → one line → minimum code). Stop at the first rung that holds.
- **Blade 2 — prose:** facts and code, no preamble, no restating the ask, no trailing summary. Fragments over sentences where meaning survives.

Trigger words: "comb", "comb mode", "be lazy", "keep it short", "yagni", "minimal", "no fluff", or complaining about over-engineering/bloat/long-winded answers. Off: "stop comb" / "normal mode". One blade only: "comb code" or "comb prose".

Full rules: [`skills/comb/SKILL.md`](skills/comb/SKILL.md).

## What's in this repo

| Piece | Where |
|---|---|
| Claude Code skill (source of truth) | `skills/comb/SKILL.md` |
| Claude Code plugin manifest | `.claude-plugin/` |
| Claude Code compression hook | `hooks/hooks.json` + `scripts/compress-tool-output.js` |
| Cursor | `.cursor/rules/comb.mdc` |
| Windsurf | `.windsurf/rules/comb.md` |
| Cline | `.clinerules/comb.md` |
| Kiro | `.kiro/steering/comb.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Codex / Amp (agent-agnostic) | `AGENTS.md`, `.codex-plugin/plugin.json` |
| Gemini CLI | `GEMINI.md`, `gemini-extension.json` |
| Hermes | `skills/comb/SKILL.hermes.md` (skill), `.hermes/plugins/comb/` (compression hook) |
| Benchmark vs rdxmin | `benchmarks/vs-rdxmin.js` |
| Tests | `test/compress.test.js` |

The persona rules are the same content everywhere. The tool-output compressor (elides oversized Bash/Agent/WebFetch/WebSearch/Grep/Glob/MCP output, keeps head/tail/error lines) only exists where the host has a matching hook point — Claude Code (`PostToolUse`) and Hermes (`transform_tool_result`) today.

## Install

**Claude Code (plugin):**
```bash
claude plugin marketplace add maxkilla/comb
claude plugin install comb@comb
```

**Cursor / Windsurf / Cline / Kiro / Copilot:** clone this repo's rule file into your project (or copy it in) — e.g. `.cursor/rules/comb.mdc` into your project's `.cursor/rules/`.

**Codex / Amp:** drop `AGENTS.md` into your project root, or merge its contents into an existing one.

**Gemini CLI:** `gemini extensions install` supports installing from a git repo — see `gemini extensions install --help` for the exact syntax your version expects. Manual fallback: copy `GEMINI.md` into your project root.

**Hermes:**
```bash
cp -r .hermes/plugins/comb ~/.hermes/plugins/comb
mkdir -p ~/.hermes/skills/software-development/comb
cp skills/comb/SKILL.hermes.md ~/.hermes/skills/software-development/comb/SKILL.md
```
Then add `comb` to `plugins.enabled` in `~/.hermes/config.yaml`:
```yaml
plugins:
  enabled:
    - comb
```
Plugin's `kind` is omitted in `plugin.yaml` — Hermes defaults that to `standalone`, which is what makes the `enabled` list opt-in required. (Project-local install: `./.hermes/plugins/comb/`, requires `HERMES_ENABLE_PROJECT_PLUGINS=1`.)

## Tool-output compressor tuning (Claude Code + Hermes)

Env vars, both ports:
```
COMB_COMPRESS_HEAD       # chars kept from the start (default 1200)
COMB_COMPRESS_TAIL       # chars kept from the end (default 800)
COMB_COMPRESS_THRESHOLD  # only compress above this size (default 3000)
COMB_COMPRESS=0          # kill switch (Hermes only; 0/false/no/off) — disables without touching config.yaml
```

## Benchmark

`benchmarks/vs-rdxmin.js` replays your real Claude Code transcripts through both comb's and rdxmin's compression code — deterministic, zero LLM calls:

```bash
node benchmarks/vs-rdxmin.js
```

## Test

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
