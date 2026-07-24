#!/usr/bin/env node
'use strict';

// comb tool-output compressor — PostToolUse hook.
//
// Elides the middle of oversized Bash/Agent/WebFetch/WebSearch/Grep/Glob/MCP
// output, keeping the head, the tail, and any line that looks like an error.
// Deterministic, zero dependencies, never touches Read/Edit/Write (those
// aren't even in this hook's matcher — see hooks/hooks.json).
//
// UNVERIFIED ASSUMPTION, READ BEFORE TRUSTING THIS: Claude Code's docs don't
// publish an exact tool_response schema per tool. This guesses common field
// names (output/stdout/content/text/result) and no-ops — never guesses wrong
// and never corrupts output — if it doesn't recognize the shape. Run once
// with COMB_COMPRESS_DEBUG=1 to see the real shape for your version and
// adjust FIELD_CANDIDATES below if needed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HEAD_CHARS = Number(process.env.COMB_COMPRESS_HEAD) || 1200;
const TAIL_CHARS = Number(process.env.COMB_COMPRESS_TAIL) || 800;
const THRESHOLD = Number(process.env.COMB_COMPRESS_THRESHOLD) || 3000;
// Mirrors OpenDev's truncation.rs (crates/opendev-tools-impl): elision is
// otherwise irreversible — once the middle is gone, it's gone. Opt-out
// (not opt-in) because losing data silently is worse than a stray file on
// disk; set COMB_COMPRESS_SAVE_FULL=0 to disable.
const SAVE_FULL = process.env.COMB_COMPRESS_SAVE_FULL !== '0';
const OVERFLOW_DIR = path.join(os.homedir(), '.claude', 'comb', 'tool-output');
// Same cap as OpenDev: never let one huge tool call write unbounded bytes
// to disk. Past this, keep head 75% + tail 25% of the *original* text in
// the saved file too (same shape as the in-context elision, just a much
// bigger window).
const MAX_OVERFLOW_BYTES = 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Ceiling on the critical-gate bypass (see middleHasExcessErrors below): a
// dense-error output only skips compression entirely if it's still small.
// Above this, letting it through whole would defeat the compressor's whole
// purpose — fall back to elision + capped salvage instead.
const GATE_MAX_CHARS = Number(process.env.COMB_COMPRESS_GATE_MAX) || 20000;
const MAX_ERROR_LINES = 15;
// No \b around "error": word-boundary matching misses "ValueError",
// "TypeError", "KeyError", etc. — camelCase error names are exactly what
// we most need to salvage. Trades a little false-positive risk (e.g. the
// substring inside "terrorism") for not missing real ones.
const ERROR_PATTERN = /error|exception|traceback|fail(ed|ure)?|fatal|panic/i;
const FIELD_CANDIDATES = ['output', 'stdout', 'content', 'text', 'result'];
const STATS_FILE = path.join(os.homedir(), '.claude', 'comb', 'stats.json');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Finds the text worth compressing inside tool_response, and a rebuild()
// that writes a replacement back into the same shape it came from.
function locateText(toolResponse) {
  if (typeof toolResponse === 'string') {
    return { text: toolResponse, rebuild: (compressed) => compressed };
  }
  if (toolResponse && typeof toolResponse === 'object') {
    for (const field of FIELD_CANDIDATES) {
      const value = toolResponse[field];
      if (typeof value === 'string') {
        return {
          text: value,
          rebuild: (compressed) => ({ ...toolResponse, [field]: compressed }),
        };
      }
    }
  }
  return null; // unrecognized shape — don't touch it
}

function salvageErrorLines(middle) {
  return scanErrors(middle).kept;
}

// TACO-style critical gate (arXiv:2604.19572): salvageErrorLines caps at
// MAX_ERROR_LINES, so a middle with more distinct error-looking lines than
// that would have some silently dropped. Rather than guess which ones
// matter, treat the whole output as too risky to touch and leave it whole.
// Early-exits as soon as it's seen one more than the cap — enough to know,
// without a full scan on relentlessly noisy output.
function middleHasExcessErrors(middle) {
  return scanErrors(middle).excess;
}

// Single-pass version of the two functions above. compress() previously
// called middleHasExcessErrors(middle) then salvageErrorLines(middle) in
// sequence — two independent middle.split('\n') calls plus two full
// regex-test loops over the same text. Profiling showed this pair costs
// ~55% of compress()'s total time on typical inputs; merging into one
// split + one loop roughly halves it (median 146us -> 70us on a 2000-line
// middle in local benchmarking).
//
// kept is ALWAYS the first MAX_ERROR_LINES deduped matches, independent of
// excess — matches the original two-call behavior, where compress() only
// used middleHasExcessErrors() to decide whether to bail out entirely
// (when text.length <= GATE_MAX_CHARS); when it didn't bail (dense errors
// in a large output, past the gate ceiling), salvageErrorLines() still ran
// and returned its normal cap-15 list. An earlier version of this merge
// wrongly zeroed kept whenever excess was true, which broke exactly that
// gate-ceiling case — caught by test/compress.test.js's existing
// "still elides a dense-error output above the gate size ceiling" test.
// salvageErrorLines/middleHasExcessErrors stay as separate exports (kept
// for anyone depending on the old two-call shape) but both now delegate
// here so the hot path only pays for one scan.
function scanErrors(middle) {
  const seen = new Set();
  const kept = [];
  for (const line of middle.split('\n')) {
    if (!ERROR_PATTERN.test(line) || seen.has(line)) continue;
    seen.add(line);
    if (kept.length < MAX_ERROR_LINES) kept.push(line);
    // kept is provably already at MAX_ERROR_LINES by the time seen.size
    // exceeds it (kept.push happens strictly before seen.size can reach
    // MAX_ERROR_LINES+1), so returning immediately here loses nothing.
    if (seen.size > MAX_ERROR_LINES) return { excess: true, kept };
  }
  return { excess: false, kept };
}

// Chance of running cleanupOldFiles() on any given saveOverflow() call —
// keeps RETENTION_MS actually enforced without a directory scan on every
// hot-path call (see cleanupOldFiles below; it was previously defined but
// never invoked anywhere, so OVERFLOW_DIR grew unbounded by default).
const CLEANUP_PROBABILITY = 0.02;

// Saves the full, untouched text to a uniquely-named file in OVERFLOW_DIR.
// Never throws — on any filesystem error, returns null and the caller just
// omits the recovery hint (elision still happens; it's the file that's
// best-effort, not the compression). If text exceeds MAX_OVERFLOW_BYTES,
// the saved file is itself capped head75/tail25 rather than truncated flat,
// so both "how it started" and "how it ended" survive even in the worst case.
function saveOverflow(text) {
  try {
    fs.mkdirSync(OVERFLOW_DIR, { recursive: true, mode: 0o700 });
    const filename = `tool_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const filepath = path.join(OVERFLOW_DIR, filename);

    let toWrite = text;
    if (Buffer.byteLength(text, 'utf8') > MAX_OVERFLOW_BYTES) {
      const headSize = Math.floor((MAX_OVERFLOW_BYTES * 3) / 4);
      const tailSize = MAX_OVERFLOW_BYTES - headSize;
      const head = text.slice(0, headSize);
      const tail = text.slice(-tailSize);
      const omitted = text.length - headSize - tailSize;
      toWrite = `${head}\n\n[... ${omitted} chars omitted from overflow file ...]\n\n${tail}`;
    }

    fs.writeFileSync(filepath, toWrite, { mode: 0o600 });
    if (Math.random() < CLEANUP_PROBABILITY) cleanupOldFiles();
    return filepath;
  } catch {
    return null; // best-effort — never block the hook on a disk write
  }
}

// Removes overflow files older than RETENTION_MS. Invoked opportunistically
// (CLEANUP_PROBABILITY) from saveOverflow rather than on every hot-path
// call, and exported for anyone who'd rather wire it into a SessionStart
// hook or cron instead.
function cleanupOldFiles() {
  let entries;
  try {
    entries = fs.readdirSync(OVERFLOW_DIR, { withFileTypes: true });
  } catch {
    return 0; // directory doesn't exist yet — nothing to clean
  }
  const cutoff = Date.now() - RETENTION_MS;
  let cleaned = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('tool_')) continue;
    const filepath = path.join(OVERFLOW_DIR, entry.name);
    try {
      const { mtimeMs } = fs.statSync(filepath);
      if (mtimeMs < cutoff) {
        fs.unlinkSync(filepath);
        cleaned += 1;
      }
    } catch {
      // file vanished or unreadable between readdir and stat — skip it
    }
  }
  return cleaned;
}

// Cheap looks-like-JSON check -- first non-whitespace char is { or [. Not a
// real parse, just enough to decide whether snapToJsonBoundary's search is
// worth attempting. False positives (e.g. text that starts with { but isn't
// valid JSON) just mean a wasted bounded search, not incorrect output --
// snapToJsonBoundary falls back to null (raw cut) if it finds no boundary.
function looksLikeJson(text) {
  const c = text.trimStart()[0];
  return c === '{' || c === '[';
}

// Finds the nearest line that's just a closing brace/bracket at shallow
// indent (<=6 spaces) -- the element boundary in pretty-printed JSON
// (JSON.stringify(x, null, 2)-style output, which is what most tool_result
// JSON actually looks like). Without this, a raw char-index cut lands
// mid-object about as often as not, producing output that isn't valid JSON
// and error-salvage lines with no surrounding context. Bounded 8-line
// search in the given direction from the char cut; returns null (caller
// falls back to the raw cut, today's behavior) if nothing nearby matches --
// this is deliberately NOT a JSON parser, just a pattern match on the
// common pretty-printed shape, per the efficiency ladder: this rung holds
// for the common case, a real parser would be over-engineering for it.
const JSON_BOUNDARY_RE = /^ {0,6}[}\]],?\s*$/;
function snapToJsonBoundary(text, cutIndex, direction) {
  const lines = text.split('\n');
  let pos = 0;
  let lineIdx = 0;
  for (; lineIdx < lines.length; lineIdx++) {
    if (pos + lines[lineIdx].length + 1 > cutIndex) break;
    pos += lines[lineIdx].length + 1;
  }
  for (let step = 0; step < 8; step++) {
    const i = direction === 'forward' ? lineIdx + step : lineIdx - step;
    if (i < 0 || i >= lines.length) continue;
    if (JSON_BOUNDARY_RE.test(lines[i])) {
      let offset = 0;
      for (let j = 0; j <= i; j++) offset += lines[j].length + 1;
      return offset;
    }
  }
  return null;
}

function compress(text) {
  if (text.length <= THRESHOLD) return null; // not worth touching

  let headCut = HEAD_CHARS;
  let tailCut = text.length - TAIL_CHARS;
  if (looksLikeJson(text)) {
    headCut = snapToJsonBoundary(text, headCut, 'backward') ?? headCut;
    tailCut = snapToJsonBoundary(text, tailCut, 'forward') ?? tailCut;
  }

  const head = text.slice(0, headCut);
  const tail = text.slice(tailCut);
  const middle = text.slice(headCut, tailCut);

  const { excess, kept: errorLines } = scanErrors(middle);

  // Full bypass only below GATE_MAX_CHARS — past that, a huge dense-error
  // blob still needs elision, just with the existing salvage cap.
  if (excess && text.length <= GATE_MAX_CHARS) return null;

  const savedPath = SAVE_FULL ? saveOverflow(text) : null;

  const marker =
    `\n… [comb: elided ${middle.length} chars` +
    (errorLines.length ? `, ${errorLines.length} error line(s) kept below` : '') +
    (savedPath ? `, full output: ${savedPath}` : '') +
    `] …\n`;
  const errorBlock = errorLines.length ? errorLines.join('\n') + '\n' : '';

  const result = head + marker + errorBlock + tail;
  recordSavings(text.length - result.length);
  return result;
}

// Cumulative savings ledger for the statusline (scripts/comb-statusline.sh).
// Best-effort, never throws, never blocks the hook — a lost stats update
// just means an undercounted badge, not a broken compression. Refuses
// symlinks (attacker-controlled path swap) and caps writes at mode 0600.
function recordSavings(saved) {
  try {
    try { if (fs.lstatSync(STATS_FILE).isSymbolicLink()) return; } catch (e) { if (e.code !== 'ENOENT') return; }
    let stats = { savedChars: 0, events: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      if (parsed && Number.isFinite(parsed.savedChars) && Number.isFinite(parsed.events)) stats = parsed;
    } catch { /* missing/corrupt — start fresh */ }
    stats.savedChars += saved;
    stats.events += 1;
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stats), { mode: 0o600 });
    fs.renameSync(tmp, STATS_FILE);
  } catch { /* best-effort — stats are not load-bearing */ }
}

async function main() {
  const raw = await readStdin();

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed input — stay silent, never block the tool call
  }

  if (process.env.COMB_COMPRESS_DEBUG === '1') {
    process.stderr.write(JSON.stringify(input, null, 2) + '\n');
    process.exit(0);
  }

  const located = locateText(input.tool_response);
  if (!located) process.exit(0); // unrecognized shape — no-op, never guess

  const compressed = compress(located.text);
  if (compressed === null) process.exit(0); // under threshold — no-op

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: located.rebuild(compressed),
      },
    })
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  compress, locateText, salvageErrorLines, middleHasExcessErrors, scanErrors,
  looksLikeJson, snapToJsonBoundary,
  saveOverflow, cleanupOldFiles, recordSavings,
  THRESHOLD, HEAD_CHARS, TAIL_CHARS, GATE_MAX_CHARS, SAVE_FULL, OVERFLOW_DIR, MAX_OVERFLOW_BYTES, RETENTION_MS, STATS_FILE,
};
