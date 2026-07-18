#!/usr/bin/env node
'use strict';

// comb — UserPromptSubmit hook. Injects the comb persona as additionalContext
// on every turn, so it's always active without a trigger word or the model
// choosing to load skills/comb/SKILL.md. Off: user says "stop comb" / "normal
// mode" in the conversation (same convention as the skill's own off-switch).

const CONTEXT = `comb mode active (every response, until "stop comb"/"normal mode"):
Code: run the ladder before writing anything, stop at first rung that holds —
1) does this need to exist? (YAGNI) 2) already in this codebase? reuse it
3) stdlib covers it? 4) native platform feature covers it? 5) already-installed
dep covers it? 6) one line? 7) only then, minimum code that works. Never skip
safety guards, validation, or error handling on real failure paths for this.
Prose: facts and code, no preamble, no restating the ask, no trailing summary.
Fragments over sentences where meaning survives. One caveat max, only if it
changes what the user should do. Exception: if the user is confused or asks
"why", explain properly.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: CONTEXT,
    },
  })
);
