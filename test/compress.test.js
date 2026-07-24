'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compress, locateText, salvageErrorLines, middleHasExcessErrors, scanErrors, looksLikeJson, snapToJsonBoundary } = require('../scripts/compress-tool-output.js');

test('compress: leaves short text untouched', () => {
  assert.equal(compress('short output'), null);
});

test('compress: elides the middle of long text, keeps head and tail intact', () => {
  const head = 'A'.repeat(1200);
  const middle = 'B'.repeat(5000);
  const tail = 'C'.repeat(800);
  const result = compress(head + middle + tail);
  assert.ok(result.startsWith(head));
  assert.ok(result.endsWith(tail));
  assert.ok(result.includes('elided'));
  assert.ok(result.length < (head + middle + tail).length);
});

test('compress: salvages error lines out of the elided middle', () => {
  const head = 'A'.repeat(1200);
  const noise = 'B\n'.repeat(2000);
  const errorText = 'Traceback (most recent call last):\nValueError: bad input\n';
  const tail = 'C'.repeat(800);
  const result = compress(head + noise + errorText + noise + tail);
  assert.ok(result.includes('Traceback (most recent call last):'));
  assert.ok(result.includes('ValueError: bad input'));
});

test('salvageErrorLines: caps at 15 lines and dedupes repeats', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `error line ${i % 3}`).join('\n');
  const kept = salvageErrorLines(lines);
  assert.ok(kept.length <= 15);
  assert.equal(new Set(kept).size, kept.length);
});

test('compress: leaves output whole when error lines exceed the salvage cap', () => {
  const head = 'A'.repeat(1200);
  const noise = 'B\n'.repeat(500);
  // 20 distinct error lines, well past MAX_ERROR_LINES (15) -- salvage
  // would have to drop 5 of them, so the gate should refuse to touch it.
  const manyErrors = Array.from({ length: 20 }, (_, i) => `Error: failure case ${i}`).join('\n') + '\n';
  const tail = 'C'.repeat(800);
  const original = head + noise + manyErrors + noise + tail;
  assert.equal(compress(original), null);
});

test('compress: still elides a dense-error output above the gate size ceiling', () => {
  // Same excess-error shape as above, but padded past GATE_MAX_CHARS (20000
  // default) -- full bypass here would defeat the compressor's purpose, so
  // it should fall back to elision with the normal salvage cap instead.
  const head = 'A'.repeat(1200);
  const bigNoise = 'B\n'.repeat(15000);
  const manyErrors = Array.from({ length: 20 }, (_, i) => `Error: failure case ${i}`).join('\n') + '\n';
  const tail = 'C'.repeat(800);
  const original = head + bigNoise + manyErrors + bigNoise + tail;
  const result = compress(original);
  assert.notEqual(result, null);
  assert.ok(result.length < original.length);
  assert.ok(result.includes('Error: failure case 0'));
});

test('compress: still compresses when error lines are within the salvage cap', () => {
  const head = 'A'.repeat(1200);
  const noise = 'B\n'.repeat(2000);
  // 3 distinct error lines -- well under the cap, gate should not trip.
  const fewErrors = 'Error: one\nError: two\nError: three\n';
  const tail = 'C'.repeat(800);
  const result = compress(head + noise + fewErrors + noise + tail);
  assert.notEqual(result, null);
  assert.ok(result.includes('Error: one'));
  assert.ok(result.length < (head + noise + fewErrors + noise + tail).length);
});

test('middleHasExcessErrors: true past the cap, false at or under it', () => {
  const over = Array.from({ length: 16 }, (_, i) => `error ${i}`).join('\n');
  const atCap = Array.from({ length: 15 }, (_, i) => `error ${i}`).join('\n');
  assert.equal(middleHasExcessErrors(over), true);
  assert.equal(middleHasExcessErrors(atCap), false);
});

test('locateText: handles a plain string tool_response', () => {
  const located = locateText('hello world');
  assert.equal(located.text, 'hello world');
  assert.equal(located.rebuild('compressed'), 'compressed');
});

test('locateText: handles an object with a recognized field, preserves other fields', () => {
  const located = locateText({ output: 'hello world', exitCode: 0 });
  assert.equal(located.text, 'hello world');
  assert.deepEqual(located.rebuild('compressed'), { output: 'compressed', exitCode: 0 });
});

test('locateText: returns null for unrecognized shapes (fail safe, never guesses)', () => {
  assert.equal(locateText({ weirdField: 123 }), null);
  assert.equal(locateText(42), null);
  assert.equal(locateText(null), null);
});

// scanErrors merges middleHasExcessErrors + salvageErrorLines into one pass
// (single split('\n'), single regex-test loop) for a measured ~2x speedup
// on the hot path. These tests lock in the contract compress() actually
// relies on: kept is ALWAYS the first MAX_ERROR_LINES deduped matches,
// regardless of excess -- an earlier version of this merge wrongly zeroed
// kept whenever excess was true, which broke the gate-ceiling case in
// compress() (dense errors in output too large to bypass). Caught by the
// "still elides a dense-error output above the gate size ceiling" test
// above; these tests exercise scanErrors directly so a future refactor
// can't reintroduce the same bug without a JS test failing on this file
// specifically, not just transitively through compress().

test('scanErrors: kept is populated even when excess is true (the bug this guards against)', () => {
  const manyErrors = Array.from({ length: 20 }, (_, i) => `Error: case ${i}`).join('\n');
  const { excess, kept } = scanErrors(manyErrors);
  assert.equal(excess, true);
  assert.ok(kept.length > 0, 'kept must not be emptied just because excess is true');
  assert.equal(kept.length, 15); // MAX_ERROR_LINES
  assert.equal(kept[0], 'Error: case 0');
});

test('scanErrors: excess false and kept under cap for a normal sparse-error middle', () => {
  const middle = 'noise\n'.repeat(50) + 'Error: one\nnoise\nError: two\n' + 'noise\n'.repeat(50);
  const { excess, kept } = scanErrors(middle);
  assert.equal(excess, false);
  assert.deepEqual(kept, ['Error: one', 'Error: two']);
});

test('scanErrors: matches middleHasExcessErrors + salvageErrorLines exactly across cases', () => {
  const cases = [
    'B\n'.repeat(2000),
    'Traceback (most recent call last):\nValueError: bad input\n' + 'B\n'.repeat(500),
    Array.from({ length: 20 }, (_, i) => `Error: failure case ${i}`).join('\n') + '\n' + 'B\n'.repeat(500),
    'Error: one\nError: two\nError: three\n' + 'B\n'.repeat(500),
  ];
  for (const middle of cases) {
    const { excess, kept } = scanErrors(middle);
    assert.equal(excess, middleHasExcessErrors(middle));
    assert.deepEqual(kept, salvageErrorLines(middle));
  }
});

// JSON-aware boundary snapping. A raw HEAD_CHARS/TAIL_CHARS char-index cut
// lands mid-object about as often as not on pretty-printed JSON tool
// output, producing invalid JSON and context-free error salvage lines.
// snapToJsonBoundary finds the nearest complete-element boundary (a line
// that's just a closing brace/bracket) via bounded line search -- not a
// real parser, deliberately, per the efficiency ladder.

test('looksLikeJson: true for objects and arrays, false for plain text', () => {
  assert.equal(looksLikeJson('{"a":1}'), true);
  assert.equal(looksLikeJson('[1,2,3]'), true);
  assert.equal(looksLikeJson('  \n  {"a":1}'), true); // leading whitespace tolerated
  assert.equal(looksLikeJson('plain log output\nline 2'), false);
  assert.equal(looksLikeJson('Traceback (most recent call last):'), false);
});

test('snapToJsonBoundary: finds nearest closing-brace line within 8 lines, backward', () => {
  const text = '{\n  "a": 1,\n  "b": {\n    "c": 2\n  },\n  "d": 3\n}\n';
  // cut mid "d": 3 line -- nearest backward boundary is the "  }," line above it
  const cutIndex = text.indexOf('"d"') + 2;
  const snapped = snapToJsonBoundary(text, cutIndex, 'backward');
  assert.notEqual(snapped, null);
  assert.ok(text.slice(0, snapped).trimEnd().endsWith('},'));
});

test('snapToJsonBoundary: returns null when no boundary within 8 lines (safe fallback)', () => {
  const text = Array.from({ length: 20 }, (_, i) => `  "key${i}": "value with no braces at all"`).join(',\n');
  const snapped = snapToJsonBoundary(text, 100, 'backward');
  assert.equal(snapped, null);
});

test('compress: JSON tool output -- head chunk ends on a complete element boundary, not mid-object', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({
    id: i, name: `item_${i}`, status: i % 41 === 0 ? 'error' : 'ok',
  }));
  const jsonOutput = JSON.stringify({ results: items }, null, 2);
  const result = compress(jsonOutput);
  assert.notEqual(result, null);

  const markerIdx = result.indexOf('… [comb:');
  const headChunk = result.slice(0, markerIdx);
  // The old raw-cut behavior would end mid-line/mid-object; the fix should
  // land on a clean boundary line ("},", "}", "],", or "]") once trailing
  // whitespace is trimmed.
  assert.match(headChunk.trimEnd(), /[}\]],?$/, `head chunk should end on a clean brace boundary, got: ${JSON.stringify(headChunk.slice(-60))}`);
});

test('compress: non-JSON text is completely unaffected by the boundary-snap change', () => {
  const head = 'A'.repeat(1200);
  const middle = 'B'.repeat(5000);
  const tail = 'C'.repeat(800);
  const result = compress(head + middle + tail);
  // Identical to the pre-existing behavior test: exact head/tail preserved
  assert.ok(result.startsWith(head));
  assert.ok(result.endsWith(tail));
});
