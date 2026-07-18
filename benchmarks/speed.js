#!/usr/bin/env node
// comb vs rdxmin — latency benchmark (wall-clock, deterministic, zero LLM).
//
// Times every eligible tool_result from your real Claude Code transcripts
// through both hooks' actual compress code — including under-threshold
// calls that no-op, since the hook pays that cost on every single tool
// call regardless of size. Reports µs/call distribution + throughput.
//
// Usage:
//   node benchmarks/speed.js [rdxmin-hook-path]
//
// Writes benchmarks/results/speed.svg + speed.md for the README chart.

'use strict';

process.env.COMB_COMPRESS_SAVE_FULL = '0';

const fs = require('fs');
const path = require('path');
const os = require('os');

const comb = require('../scripts/compress-tool-output.js');
const hooksConfig = require('../hooks/hooks.json');

const MATCHER = hooksConfig.hooks.PostToolUse[0].matcher;
const MATCHER_RE = new RegExp(`^(${MATCHER})$`);
function toolAllowed(name) {
  return typeof name === 'string' && MATCHER_RE.test(name);
}

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
const rdxLimits = rdxmin ? rdxmin.limitsFor('full') : null;

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

const root = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');

const timings = { comb: [], rdxmin: [] };
const chars = { comb: 0, rdxmin: 0 };
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

        let t0 = process.hrtime.bigint();
        comb.compress(text);
        let t1 = process.hrtime.bigint();
        timings.comb.push(Number(t1 - t0) / 1000); // µs
        chars.comb += text.length;

        if (rdxmin) {
          t0 = process.hrtime.bigint();
          rdxmin.transform(text, rdxLimits);
          t1 = process.hrtime.bigint();
          timings.rdxmin.push(Number(t1 - t0) / 1000);
          chars.rdxmin += text.length;
        }
      }
    }
  }
}

walk(root);

function stats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    n: sorted.length,
    avg: sum / sorted.length,
    median: pct(50),
    p95: pct(95),
    max: sorted[sorted.length - 1],
    totalMs: sum / 1000,
  };
}

const combStats = stats(timings.comb);
const rdxStats = stats(timings.rdxmin);

console.log(`comb vs rdxmin — latency benchmark`);
console.log(`transcript root: ${root}`);
console.log(`tool_results scanned (allowlisted): ${scanned.toLocaleString('en-US')}\n`);

function row(label, s, totalChars) {
  if (!s) return;
  const throughput = totalChars / s.totalMs; // chars/ms
  console.log(
    `${label.padEnd(8)} n=${String(s.n).padEnd(5)} ` +
    `avg=${s.avg.toFixed(1).padStart(7)}µs  median=${s.median.toFixed(1).padStart(7)}µs  ` +
    `p95=${s.p95.toFixed(1).padStart(8)}µs  max=${s.max.toFixed(1).padStart(9)}µs  ` +
    `total=${s.totalMs.toFixed(1)}ms  throughput=${throughput.toFixed(0)} chars/ms`
  );
}
row('comb', combStats, chars.comb);
row('rdxmin', rdxStats, chars.rdxmin);

if (!rdxmin) {
  console.log(`\nrdxmin hook not found — pass its path as argv[1] or set RDXMIN_HOOK_PATH to compare.`);
}

// ---------------------------------------------------------------------------
// Chart + results file for the README (only written when both sides ran).
// ---------------------------------------------------------------------------
if (combStats && rdxStats) {
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'speed.svg'), renderChart(combStats, rdxStats));
  fs.writeFileSync(path.join(outDir, 'speed.md'), renderMarkdown(combStats, rdxStats, scanned, root));
  console.log(`\nWrote benchmarks/results/speed.svg + speed.md`);
}

function renderChart(comb_, rdx_) {
  // Median omitted: both compressors resolve under-threshold no-ops in
  // ~0.2µs, which flattens to an invisible sliver on a linear axis next to
  // a several-hundred-µs p95 — not a meaningful chart comparison. Still in
  // the results table below.
  const metrics = [
    { label: 'avg', comb: comb_.avg, rdx: rdx_.avg },
    { label: 'p95', comb: comb_.p95, rdx: rdx_.p95 },
  ];
  const max = Math.max(...metrics.flatMap((m) => [m.comb, m.rdx])) * 1.15;
  const W = 480, H = 220, padL = 60, padB = 30, padT = 20;
  const groupW = (W - padL - 20) / metrics.length;
  const barW = groupW * 0.32;
  const scaleY = (H - padT - padB) / max;

  let bars = '';
  metrics.forEach((m, i) => {
    const gx = padL + i * groupW + groupW * 0.15;
    const combH = m.comb * scaleY;
    const rdxH = m.rdx * scaleY;
    bars += `
    <rect x="${gx}" y="${H - padB - combH}" width="${barW}" height="${combH}" fill="#2ea043"/>
    <text x="${gx + barW / 2}" y="${H - padB - combH - 4}" font-size="10" text-anchor="middle" fill="currentColor">${m.comb.toFixed(1)}</text>
    <rect x="${gx + barW + 6}" y="${H - padB - rdxH}" width="${barW}" height="${rdxH}" fill="#ac8b1e"/>
    <text x="${gx + barW + 6 + barW / 2}" y="${H - padB - rdxH - 4}" font-size="10" text-anchor="middle" fill="currentColor">${m.rdx.toFixed(1)}</text>
    <text x="${gx + barW + 3}" y="${H - padB + 16}" font-size="11" text-anchor="middle" fill="currentColor">${m.label}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" color="#666">
  <text x="${padL}" y="14" font-size="12" fill="currentColor">µs per tool_result (lower is better)</text>
  <line x1="${padL}" y1="${H - padB}" x2="${W - 10}" y2="${H - padB}" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  ${bars}
  <rect x="${W - 130}" y="4" width="10" height="10" fill="#2ea043"/><text x="${W - 116}" y="13" font-size="11" fill="currentColor">comb</text>
  <rect x="${W - 70}" y="4" width="10" height="10" fill="#ac8b1e"/><text x="${W - 56}" y="13" font-size="11" fill="currentColor">rdxmin</text>
</svg>`;
}

function renderMarkdown(comb_, rdx_, n, root_) {
  const date = new Date().toISOString().slice(0, 10);
  return `# ${date} — comb vs rdxmin latency

Deterministic replay over real Claude Code transcripts (\`${root_}\`), ${n.toLocaleString('en-US')} eligible tool_results. Wall-clock \`process.hrtime\` around each hook's compress function, including under-threshold calls that no-op (the real per-call cost the hook adds to every tool call, not just the ones it compresses).

**Caveat:** this measures pure function CPU time inside one shared warm process. In production each hook invocation is a separate \`node script.js\` process spawned by Claude Code per tool call — process-spawn overhead (tens of ms, identical for any Node-based hook) dwarfs the microsecond-level differences below. Read this as "which algorithm does less work," not "which hook feels faster."

Reproduce: \`node benchmarks/speed.js\`

| | n | avg µs | median µs | p95 µs | max µs | total ms |
|---|--:|--:|--:|--:|--:|--:|
| comb | ${comb_.n} | ${comb_.avg.toFixed(1)} | ${comb_.median.toFixed(1)} | ${comb_.p95.toFixed(1)} | ${comb_.max.toFixed(1)} | ${comb_.totalMs.toFixed(1)} |
| rdxmin | ${rdx_.n} | ${rdx_.avg.toFixed(1)} | ${rdx_.median.toFixed(1)} | ${rdx_.p95.toFixed(1)} | ${rdx_.max.toFixed(1)} | ${rdx_.totalMs.toFixed(1)} |

![speed chart](speed.svg)
`;
}

module.exports = { stats, extractText, toolAllowed };
