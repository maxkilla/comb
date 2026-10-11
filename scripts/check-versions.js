#!/usr/bin/env node
'use strict';
// Fails if comb's four manifests disagree on version (the ponytail v4.8.0 bug:
// manifests shipped stale, so plugins reported the old version after update).
// Optional: pass a release tag (v1.2.3) as argv[2] to also match it.
const fs = require('fs');
const path = require('path');

function readVersions(root) {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const yaml = /^version:\s*["']?([^"'\s#]+)/m.exec(read('plugin.yaml'));
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'plugin.yaml': yaml && yaml[1],
    '.claude-plugin/plugin.json': JSON.parse(read('.claude-plugin/plugin.json')).version,
    '.claude-plugin/marketplace.json': market.plugins && market.plugins[0] && market.plugins[0].version,
  };
}

function checkVersions(root, tag) {
  const v = readVersions(root);
  const want = tag ? tag.replace(/^v/, '') : Object.values(v)[0];
  const bad = Object.entries(v).filter(([, x]) => x !== want);
  return { versions: v, expected: want, mismatches: bad.map(([f, x]) => `${f}: ${x === undefined || x === null ? 'missing' : x} (expected ${want})`) };
}

if (require.main === module) {
  const r = checkVersions(path.join(__dirname, '..'), process.argv[2]);
  if (r.mismatches.length) { console.error('version mismatch:\n  ' + r.mismatches.join('\n  ')); process.exit(1); }
  console.log(`versions consistent: ${r.expected}`);
}
module.exports = { readVersions, checkVersions };
