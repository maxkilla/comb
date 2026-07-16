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

// Optional rule-store lookup, tried before the generic elision below. Unset
// COMB_RULE_STORE_URL and this whole path is skipped — comb stays
// zero-dependency and zero-network by default, this is opt-in.
const RULE_STORE_TIMEOUT_MS = Number(process.env.COMB_RULE_STORE_TIMEOUT_MS) || 500;

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
  const seen = new Set();
  const kept = [];
  for (const line of middle.split('\n')) {
    if (ERROR_PATTERN.test(line) && !seen.has(line)) {
      seen.add(line);
      kept.push(line);
      if (kept.length >= MAX_ERROR_LINES) break;
    }
  }
  return kept;
}

// TACO-style critical gate (arXiv:2604.19572): salvageErrorLines caps at
// MAX_ERROR_LINES, so a middle with more distinct error-looking lines than
// that would have some silently dropped. Rather than guess which ones
// matter, treat the whole output as too risky to touch and leave it whole.
// Early-exits as soon as it's seen one more than the cap — enough to know,
// without a full scan on relentlessly noisy output.
function middleHasExcessErrors(middle) {
  const seen = new Set();
  for (const line of middle.split('\n')) {
    if (!ERROR_PATTERN.test(line) || seen.has(line)) continue;
    seen.add(line);
    if (seen.size > MAX_ERROR_LINES) return true;
  }
  return false;
}

// Saves the full, untouched text to a uniquely-named file in OVERFLOW_DIR.
// Never throws — on any filesystem error, returns null and the caller just
// omits the recovery hint (elision still happens; it's the file that's
// best-effort, not the compression). If text exceeds MAX_OVERFLOW_BYTES,
// the saved file is itself capped head75/tail25 rather than truncated flat,
// so both "how it started" and "how it ended" survive even in the worst case.
function saveOverflow(text) {
  try {
    fs.mkdirSync(OVERFLOW_DIR, { recursive: true });
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
    return filepath;
  } catch {
    return null; // best-effort — never block the hook on a disk write
  }
}

// Removes overflow files older than RETENTION_MS. Not called automatically
// by this hook (PostToolUse runs on the hot path — a directory scan every
// tool call is wasted work); wire this into a SessionStart hook or a cron
// if unbounded disk growth in OVERFLOW_DIR becomes a problem.
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

function compress(text) {
  if (text.length <= THRESHOLD) return null; // not worth touching

  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const middle = text.slice(HEAD_CHARS, text.length - TAIL_CHARS);

  // Full bypass only below GATE_MAX_CHARS — past that, a huge dense-error
  // blob still needs elision, just with the existing salvage cap.
  if (middleHasExcessErrors(middle) && text.length <= GATE_MAX_CHARS) return null;

  const errorLines = salvageErrorLines(middle);
  const savedPath = SAVE_FULL ? saveOverflow(text) : null;

  const marker =
    `\n… [comb: elided ${middle.length} chars` +
    (errorLines.length ? `, ${errorLines.length} error line(s) kept below` : '') +
    (savedPath ? `, full output: ${savedPath}` : '') +
    `] …\n`;
  const errorBlock = errorLines.length ? errorLines.join('\n') + '\n' : '';

  return head + marker + errorBlock + tail;
}

// Best-effort command string for rule-store matching. Same fail-safe
// philosophy as locateText: guess common shapes, never throw, fall back to
// tool_name so non-Bash tools still get a (likely no-match) lookup rather
// than crashing the hook.
function extractCommand(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolName || '';
  return toolInput.command || toolInput.pattern || toolInput.url || toolName || '';
}

// Tries the shared rule-store server first. Fail-open on anything —
// unset URL, network error, timeout, non-200, or "no rule matched" — by
// returning null, which sends the caller straight to the existing generic
// elision below. This must never be slower than RULE_STORE_TIMEOUT_MS or
// block the hook; PostToolUse hooks run in the hot path.
async function tryRuleStore(command, text) {
  const ruleStoreUrl = process.env.COMB_RULE_STORE_URL || null;
  if (!ruleStoreUrl) return null;
  try {
    const res = await fetch(`${ruleStoreUrl}/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, output: text }),
      signal: AbortSignal.timeout(RULE_STORE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.output !== 'string' || data.output === text) return null;
    return data.output;
  } catch {
    return null; // server down/slow/unreachable — never block on this
  }
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

  const command = extractCommand(input.tool_name, input.tool_input);
  const ruleStoreResult = await tryRuleStore(command, located.text);
  const compressed = ruleStoreResult !== null ? ruleStoreResult : compress(located.text);
  if (compressed === null) process.exit(0); // under threshold, no rule matched — no-op

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
  compress, locateText, salvageErrorLines, middleHasExcessErrors, extractCommand, tryRuleStore,
  saveOverflow, cleanupOldFiles,
  THRESHOLD, HEAD_CHARS, TAIL_CHARS, GATE_MAX_CHARS, SAVE_FULL, OVERFLOW_DIR, MAX_OVERFLOW_BYTES, RETENTION_MS,
};
