'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compress, locateText, salvageErrorLines } = require('../scripts/compress-tool-output.js');

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
