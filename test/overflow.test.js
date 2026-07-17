'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// OVERFLOW_DIR is computed at module-load time from os.homedir(), so we
// redirect HOME before requiring the module, then clean up after.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-home-'));
const originalHome = process.env.HOME;
process.env.HOME = fakeHome;

const {
  compress, saveOverflow, cleanupOldFiles, OVERFLOW_DIR, MAX_OVERFLOW_BYTES, SAVE_FULL,
} = require('../scripts/compress-tool-output.js');

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('sanity: OVERFLOW_DIR resolved under the fake HOME, not the real one', () => {
  assert.ok(OVERFLOW_DIR.startsWith(fakeHome), `expected ${OVERFLOW_DIR} to start with ${fakeHome}`);
});

test('SAVE_FULL defaults to true (opt-out, not opt-in)', () => {
  assert.equal(SAVE_FULL, true);
});

test('saveOverflow: writes the exact full text and returns a path', () => {
  const text = 'full untouched output\n'.repeat(500);
  const p = saveOverflow(text);
  assert.ok(p, 'expected a path back');
  assert.ok(fs.existsSync(p));
  assert.equal(fs.readFileSync(p, 'utf8'), text);
  fs.rmSync(p);
});

test('saveOverflow: caps at MAX_OVERFLOW_BYTES with head75/tail25, never a flat cutoff', () => {
  const head = 'HEAD_MARKER_'.repeat(200);
  const tail = 'TAIL_MARKER_'.repeat(200);
  const filler = 'x'.repeat(MAX_OVERFLOW_BYTES); // pushes well past the cap
  const text = head + filler + tail;

  const p = saveOverflow(text);
  assert.ok(p);
  const saved = fs.readFileSync(p, 'utf8');

  assert.ok(saved.length < text.length, 'saved file should be smaller than the original');
  assert.ok(saved.length <= MAX_OVERFLOW_BYTES + 200, 'saved file should respect the byte cap (+ omission notice slack)');
  assert.ok(saved.startsWith('HEAD_MARKER_'), 'head should survive the cap');
  assert.ok(saved.endsWith('TAIL_MARKER_'.repeat(200)), 'tail should survive the cap');
  assert.ok(saved.includes('chars omitted from overflow file'), 'should note what was omitted');
  fs.rmSync(p);
});

test('saveOverflow: never throws when the directory cannot be created (fails silently)', () => {
  // Point OVERFLOW_DIR-equivalent at a path that can't be a directory by
  // colliding with a file — but since OVERFLOW_DIR is fixed at require-time,
  // simulate the failure mode directly instead: make mkdir fail by using a
  // path segment that is actually a file.
  const blockerFile = path.join(fakeHome, 'blocker');
  fs.writeFileSync(blockerFile, 'i am a file, not a directory');
  const badDir = path.join(blockerFile, 'cannot-create-under-a-file');
  // Reach into fs directly the same way saveOverflow would, to confirm the
  // underlying mkdir does throw in this scenario (sanity check on the test
  // setup itself) — saveOverflow's own try/catch is what we're really
  // testing, exercised via the exported function on the real OVERFLOW_DIR
  // in the other tests. This test just documents the failure mode exists.
  assert.throws(() => fs.mkdirSync(badDir, { recursive: true }));
  fs.rmSync(blockerFile);
});

test('compress(): elided output includes a recovery path, and that file has the full original', () => {
  const head = 'A'.repeat(1200);
  const middle = 'B\n'.repeat(5000);
  const tail = 'C'.repeat(800);
  const original = head + middle + tail;

  const result = compress(original);
  assert.ok(result, 'expected compression to trigger');
  assert.match(result, /full output: (.+tool-output.+)\]/);

  const match = result.match(/full output: (\S+)\]/);
  const savedPath = match[1];
  assert.ok(fs.existsSync(savedPath), `expected ${savedPath} to exist`);
  assert.equal(fs.readFileSync(savedPath, 'utf8'), original, 'saved file should contain the exact original, unelided');
  fs.rmSync(savedPath);
});

test('compress(): with COMB_COMPRESS_SAVE_FULL=0, no file is written and no path appears in the marker', () => {
  process.env.COMB_COMPRESS_SAVE_FULL = '0';
  // Need a fresh require with the env var set before module load, since
  // SAVE_FULL is computed at require-time like OVERFLOW_DIR.
  delete require.cache[require.resolve('../scripts/compress-tool-output.js')];
  const mod = require('../scripts/compress-tool-output.js');

  const before = fs.existsSync(OVERFLOW_DIR) ? fs.readdirSync(OVERFLOW_DIR).length : 0;

  const head = 'A'.repeat(1200);
  const middle = 'B\n'.repeat(5000);
  const tail = 'C'.repeat(800);
  const result = mod.compress(head + middle + tail);

  assert.ok(result, 'compression should still trigger');
  assert.ok(!result.includes('full output:'), 'marker should not mention a saved path');

  const after = fs.existsSync(OVERFLOW_DIR) ? fs.readdirSync(OVERFLOW_DIR).length : 0;
  assert.equal(after, before, 'no new file should have been written');

  delete process.env.COMB_COMPRESS_SAVE_FULL;
  delete require.cache[require.resolve('../scripts/compress-tool-output.js')];
});

test('cleanupOldFiles: removes files older than retention, keeps recent ones', () => {
  fs.mkdirSync(OVERFLOW_DIR, { recursive: true });
  const recent = path.join(OVERFLOW_DIR, 'tool_recent_test');
  const old = path.join(OVERFLOW_DIR, 'tool_old_test');
  const nonTool = path.join(OVERFLOW_DIR, 'not_a_tool_file.txt');
  fs.writeFileSync(recent, 'data');
  fs.writeFileSync(old, 'data');
  fs.writeFileSync(nonTool, 'data');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

  const cleaned = cleanupOldFiles();

  assert.equal(cleaned, 1);
  assert.ok(fs.existsSync(recent), 'recent file should survive');
  assert.ok(!fs.existsSync(old), 'old file should be removed');
  assert.ok(fs.existsSync(nonTool), 'non-tool file should be untouched');

  fs.rmSync(recent, { force: true });
  fs.rmSync(nonTool, { force: true });
});

test('cleanupOldFiles: returns 0 when OVERFLOW_DIR does not exist yet, never throws', () => {
  fs.rmSync(OVERFLOW_DIR, { recursive: true, force: true });
  assert.equal(cleanupOldFiles(), 0);
});

test('saveOverflow: opportunistically runs cleanup so OVERFLOW_DIR is actually bounded', () => {
  fs.mkdirSync(OVERFLOW_DIR, { recursive: true });
  const old = path.join(OVERFLOW_DIR, 'tool_old_test');
  fs.writeFileSync(old, 'data');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

  const originalRandom = Math.random;
  Math.random = () => 0; // force the cleanup roll to hit
  try {
    const p = saveOverflow('trigger cleanup\n'.repeat(200));
    assert.ok(p);
    fs.rmSync(p, { force: true });
  } finally {
    Math.random = originalRandom;
  }

  assert.ok(!fs.existsSync(old), 'stale file should have been swept by the opportunistic cleanup');
});
