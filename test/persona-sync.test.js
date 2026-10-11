'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const injected = JSON.parse(execFileSync('node', [path.join(root, 'scripts/inject-comb-mode.js')]))
  .hookSpecificOutput.additionalContext;

// The live persona is a hardcoded copy of the skills; these phrases must stay in sync.
for (const phrase of ['Live state']) {
  test(`injected persona and both skill files carry "${phrase}"`, () => {
    assert.ok(injected.includes(phrase), 'inject-comb-mode.js');
    for (const f of ['skills/comb/SKILL.md', 'skills/comb/SKILL.hermes.md']) {
      assert.ok(fs.readFileSync(path.join(root, f), 'utf8').includes(phrase), f);
    }
  });
}

test('injected persona forbids answering live state from memory', () => {
  assert.match(injected, /never answered from memory/);
  assert.match(injected, /run the command now/);
});
