#!/usr/bin/env node
// comb vs rdxmin — replay benchmark (input axis, deterministic, zero LLM).
//
// Feeds every tool_result in your local Claude Code transcripts through
// BOTH hooks' actual compress code and reports what each would have saved.
// Same corpus, same tool allowlist (derived from comb's hooks/hooks.json —
// identical set to rdxmin's SAFE_TOOLS + mcp__* in practice), so the
// comparison is apples-to-apples.
//
// Usage:
//   node benchmarks/vs-rdxmin.js [rdxmin-hook-path]
//
// rdxmin-hook-path defaults to the installed plugin cache/marketplace
// location; override via RDXMIN_HOOK_PATH or the first CLI arg if you have
// a local clone instead. If not found, comb's own numbers still print.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const comb = require('../scripts/compress-tool-output.js');
const hooksConfig = require('../hooks/hooks.json');

// ---------------------------------------------------------------------------
// Tool allowlist — derived from comb's own PostToolUse matcher so this stays
// in sync with hooks/hooks.json instead of hardcoding a second copy.
// ---------------------------------------------------------------------------
const MATCHER = hooksConfig.hooks.PostToolUse[0].matcher; // "Bash|Agent|WebFetch|WebSearch|Grep|Glob|mcp__.*"
const MATCHER_RE = new RegExp(`^(${MATCHER})$`);
function toolAllowed(name) {
  return typeof name === 'string' && MATCHER_RE.test(name);
}

// ---------------------------------------------------------------------------
// rdxmin's hook — resolve from CLI arg, env, or the usual install spots.
// ---------------------------------------------------------------------------
function resolveRdxmin() {
  const candidates = [
    process.argv[2],
    process.env.RDXMIN_HOOK_PATH,
    path.join(os.homedir(), '.claude/plugins/marketplaces/rdxmin/hooks/rdx-compress-output.js'),
    path.join(os.homedir(), '.claude/plugins/cache/rdxmin/rdxmin/1.2.0/hooks/rdx-compress-output.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  return null;
}
const rdxmin = resolveRdxmin();

// ---------------------------------------------------------------------------
// Extract plain text from a tool_result content block (string, array of
// {type:'text'} blocks, or nested object) — same shape both tools' own
// replay benchmarks parse Claude Code transcripts into.
// ---------------------------------------------------------------------------
function extractText(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => (b && typeof b.text === 'string' ? b.text : extractText(b && b.content)))
      .filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof content === 'object') {
    for (const key of ['stdout', 'output', 'content', 'text', 'result']) {
      const val = content[key];
      if (typeof val === 'string' && val) return val;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Walk ~/.claude/projects/**/*.jsonl, run every eligible tool_result through
// both compressors, tally before/after.
// ---------------------------------------------------------------------------
const root = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');

const rdxLimits = rdxmin ? rdxmin.limitsFor('full') : null;

const stats = {
  comb: { eligible: 0, before: 0, after: 0, salvaged: 0 },
  rdxmin: { eligible: 0, before: 0, after: 0, salvaged: 0 },
};
const gate = { fullBypass: 0, bypassChars: 0, ceilingFallback: 0 };
let scanned = 0;

function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) scan(p);
  }
}

function scan(f) {
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return; }
  const idName = {};
  for (const l of lines) {
    if (!l) continue;
    let j;
    try { j = JSON.parse(l); } catch (e) { continue; }
    const m = j.message;
    if (!m || !m.content || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') idName[b.id] = b.name;
      else if (b.type === 'tool_result') {
        const text = extractText(b.content);
        if (!text) continue;
        const name = idName[b.tool_use_id] || '?';
        if (!toolAllowed(name)) continue;
        scanned++;

        const combOut = comb.compress(text);
        if (combOut != null) {
          stats.comb.eligible++;
          stats.comb.before += text.length;
          stats.comb.after += combOut.length;
          if (combOut.includes('error line(s) kept below')) stats.comb.salvaged++;
        }

        // TACO-style critical gate stats: only meaningful past THRESHOLD,
        // where compress() actually reaches the gate check.
        if (text.length > comb.THRESHOLD) {
          const middle = text.slice(comb.HEAD_CHARS, text.length - comb.TAIL_CHARS);
          if (comb.middleHasExcessErrors(middle)) {
            if (text.length <= comb.GATE_MAX_CHARS) {
              gate.fullBypass++;
              gate.bypassChars += text.length;
            } else {
              gate.ceilingFallback++;
            }
          }
        }

        if (rdxmin) {
          const rdxOut = rdxmin.transform(text, rdxLimits);
          if (rdxOut != null) {
            stats.rdxmin.eligible++;
            stats.rdxmin.before += text.length;
            stats.rdxmin.after += rdxOut.length;
            if (rdxOut.includes('error-like line(s) below')) stats.rdxmin.salvaged++;
          }
        }
      }
    }
  }
}

walk(root);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
function row(label, s) {
  const saved = s.before - s.after;
  console.log(
    `${label.padEnd(8)} eligible=${String(s.eligible).padEnd(5)} ` +
    `${s.before.toLocaleString('en-US').padStart(9)} -> ${s.after.toLocaleString('en-US').padStart(9)} chars  ` +
    `saved ${saved.toLocaleString('en-US').padStart(9)} (${pct(saved, s.before)})  ` +
    `salvaged=${s.salvaged}`
  );
}

console.log(`comb vs rdxmin — replay benchmark`);
console.log(`transcript root: ${root}`);
console.log(`tool_results scanned (allowlisted): ${scanned.toLocaleString('en-US')}\n`);

row('comb', stats.comb);
console.log(
  `taco-gate  full-bypass=${gate.fullBypass} (${gate.bypassChars.toLocaleString('en-US')} chars left whole, ` +
  `<=${comb.GATE_MAX_CHARS.toLocaleString('en-US')}-char ceiling)  ` +
  `ceiling-fallback=${gate.ceilingFallback} (dense-error output over the ceiling, elided with capped salvage instead)`
);
if (rdxmin) {
  row('rdxmin', stats.rdxmin);
  const combSaved = stats.comb.before - stats.comb.after;
  const rdxSaved = stats.rdxmin.before - stats.rdxmin.after;
  const diff = combSaved - rdxSaved;
  const leader = diff >= 0 ? 'comb' : 'rdxmin';
  console.log(`\n${leader} saved ${Math.abs(diff).toLocaleString('en-US')} more raw chars on this corpus.`);
  console.log(`Not apples-to-apples on trigger rate: comb's threshold is 3000 chars, ` +
    `rdxmin 'full' mode is ${rdxLimits.maxChars.toLocaleString('en-US')} chars — comb fires on more/smaller outputs. ` +
    `rdxmin also runs a lossless scrub tier (ANSI/blank-run/repeat-line) before elision; comb elides only.`);
} else {
  console.log(`\nrdxmin hook not found — pass its path as argv[1] or set RDXMIN_HOOK_PATH to compare.`);
}
