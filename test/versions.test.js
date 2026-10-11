'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkVersions } = require('../scripts/check-versions.js');

const repo = path.join(__dirname, '..');

function fixture(v) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-ver-'));
  fs.mkdirSync(path.join(d, '.claude-plugin'));
  const w = (f, s) => fs.writeFileSync(path.join(d, f), s);
  w('package.json', JSON.stringify({ version: v.pkg }));
  w('plugin.yaml', `name: comb\nversion: "${v.yaml}"\n`);
  w('.claude-plugin/plugin.json', JSON.stringify({ version: v.plugin }));
  w('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ version: v.market }] }));
  return d;
}

test('repo manifests agree on one version', () => {
  const r = checkVersions(repo);
  assert.deepStrictEqual(r.mismatches, []);
});

test('detects a stale manifest', () => {
  const r = checkVersions(fixture({ pkg: '0.2.0', yaml: '0.2.0', plugin: '0.1.0', market: '0.2.0' }));
  assert.strictEqual(r.mismatches.length, 1);
  assert.match(r.mismatches[0], /plugin\.json/);
});

test('release tag must match manifests', () => {
  const d = fixture({ pkg: '1.0.0', yaml: '1.0.0', plugin: '1.0.0', market: '1.0.0' });
  assert.deepStrictEqual(checkVersions(d, 'v1.0.0').mismatches, []);
  assert.strictEqual(checkVersions(d, 'v1.0.1').mismatches.length, 4);
});

test('missing marketplace entry is reported', () => {
  const d = fixture({ pkg: '1.0.0', yaml: '1.0.0', plugin: '1.0.0', market: '1.0.0' });
  fs.writeFileSync(path.join(d, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [] }));
  assert.match(checkVersions(d).mismatches[0], /marketplace\.json: missing/);
});
