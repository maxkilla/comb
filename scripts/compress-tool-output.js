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

const HEAD_CHARS = Number(process.env.COMB_COMPRESS_HEAD) || 1200;
const TAIL_CHARS = Number(process.env.COMB_COMPRESS_TAIL) || 800;
const THRESHOLD = Number(process.env.COMB_COMPRESS_THRESHOLD) || 3000;
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

function compress(text) {
  if (text.length <= THRESHOLD) return null; // not worth touching

  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const middle = text.slice(HEAD_CHARS, text.length - TAIL_CHARS);

  // Full bypass only below GATE_MAX_CHARS — past that, a huge dense-error
  // blob still needs elision, just with the existing salvage cap.
  if (middleHasExcessErrors(middle) && text.length <= GATE_MAX_CHARS) return null;

  const errorLines = salvageErrorLines(middle);

  const marker =
    `\n… [comb: elided ${middle.length} chars` +
    (errorLines.length ? `, ${errorLines.length} error line(s) kept below` : '') +
    `] …\n`;
  const errorBlock = errorLines.length ? errorLines.join('\n') + '\n' : '';

  return head + marker + errorBlock + tail;
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

module.exports = { compress, locateText, salvageErrorLines, middleHasExcessErrors };
