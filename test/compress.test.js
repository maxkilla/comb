'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compress, locateText, salvageErrorLines, middleHasExcessErrors, extractCommand, tryRuleStore } = require('../scripts/compress-tool-output.js');

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

test('extractCommand: prefers tool_input.command (Bash shape)', () => {
  assert.equal(extractCommand('Bash', { command: 'pytest tests/', description: 'run tests' }), 'pytest tests/');
});

test('extractCommand: falls back to pattern, then url, then tool_name', () => {
  assert.equal(extractCommand('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(extractCommand('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(extractCommand('mcp__airtable__search', {}), 'mcp__airtable__search');
});

test('extractCommand: never throws on missing/malformed tool_input', () => {
  assert.equal(extractCommand('Bash', null), 'Bash');
  assert.equal(extractCommand('Bash', undefined), 'Bash');
  assert.equal(extractCommand(undefined, undefined), '');
});

test('tryRuleStore: returns null when COMB_RULE_STORE_URL is unset (default, zero-network)', async () => {
  delete process.env.COMB_RULE_STORE_URL;
  const result = await tryRuleStore('pytest tests/', 'some output');
  assert.equal(result, null);
});

test('tryRuleStore: returns the server\'s compressed output on a match', async (t) => {
  process.env.COMB_RULE_STORE_URL = 'http://fake-rule-store:8420';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.COMB_RULE_STORE_URL;
  });

  global.fetch = async (url, opts) => {
    assert.equal(url, 'http://fake-rule-store:8420/compress');
    const body = JSON.parse(opts.body);
    assert.equal(body.command, 'pytest tests/');
    return {
      ok: true,
      json: async () => ({ output: 'compressed by rule store', rule_id: 'pytest_verbose' }),
    };
  };

  const result = await tryRuleStore('pytest tests/', 'raw pytest output');
  assert.equal(result, 'compressed by rule store');
});

test('tryRuleStore: fails open (returns null) on network error, never throws', async (t) => {
  process.env.COMB_RULE_STORE_URL = 'http://fake-rule-store:8420';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.COMB_RULE_STORE_URL;
  });

  global.fetch = async () => { throw new Error('ECONNREFUSED'); };

  const result = await tryRuleStore('pytest tests/', 'raw output');
  assert.equal(result, null);
});

test('tryRuleStore: fails open on non-200 response', async (t) => {
  process.env.COMB_RULE_STORE_URL = 'http://fake-rule-store:8420';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.COMB_RULE_STORE_URL;
  });

  global.fetch = async () => ({ ok: false });

  const result = await tryRuleStore('pytest tests/', 'raw output');
  assert.equal(result, null);
});

test('tryRuleStore: fails open when server reports no rule matched (output unchanged)', async (t) => {
  process.env.COMB_RULE_STORE_URL = 'http://fake-rule-store:8420';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.COMB_RULE_STORE_URL;
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ output: 'raw output', rule_id: null }), // unchanged text = no compression happened
  });

  const result = await tryRuleStore('docker build .', 'raw output');
  assert.equal(result, null);
});
