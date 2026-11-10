#!/usr/bin/env python3
"""C2 test: stop rule for already-clean code. Fixture is a clean ~50-line cart.py.
Same prompt five times in one session. A = persona at git ref (default main), B = working tree.
Pass per trial: only turn 1 may edit the file, and turns 2-5 are no-edit, one-line replies.
Also reports edit turns and the lines changed vs the original.
Usage: python3 run.py [N=4] [model=sonnet] [base_ref=main]"""
import difflib, hashlib, os, subprocess, sys, shutil, tempfile, json
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import lib
here = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 4
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'sonnet'
REF = sys.argv[3] if len(sys.argv) > 3 else 'main'
P = {'A': lib.persona(REF), 'B': lib.persona()}
PROMPT = 'Refactor this further: cart.py'
TURNS = 5
orig = open(os.path.join(here, 'fixture', 'cart.py')).read()

def trial(a):
    v, i = a
    wd = tempfile.mkdtemp(prefix='comb-c2-'); shutil.copytree(os.path.join(here, 'fixture'), wd, dirs_exist_ok=True)
    sid, edits, one_line, prev, changed = None, [], [], orig, 0
    for t in range(TURNS):
        cmd = ['claude', '-p', PROMPT, '--model', MODEL, '--output-format', 'json', '--allowedTools', lib.TOOLS,
               '--permission-mode', 'acceptEdits', '--append-system-prompt', P[v]]
        if sid: cmd += ['--resume', sid]
        r = subprocess.run(cmd, cwd=wd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=600)
        try: j = json.loads(r.stdout); sid = j.get('session_id', sid); reply = j.get('result', '').strip()
        except Exception: reply = r.stdout.strip()
        cur = open(os.path.join(wd, 'cart.py')).read()
        edits.append(cur != prev)
        one_line.append(len([l for l in reply.split('\n') if l.strip()]) <= 1 and len(reply) <= 240)
        prev = cur
    final = prev
    changed = sum(1 for l in difflib.unified_diff(orig.split('\n'), final.split('\n'), lineterm='') if l[:1] in '+-' and l[:3] not in ('+++', '---'))
    # spec: at most one real edit pass (turn 1 only), then a one-line no-edit answer on every later turn
    ok = sum(edits) <= 1 and (not any(edits[1:])) and all(one_line[t] for t in range(1, TURNS))
    return v, edits, one_line, changed, ok
jobs = [(v, i) for v in P for i in range(N)]
with ThreadPoolExecutor(6) as ex: out = list(ex.map(trial, jobs))
print(f'model={MODEL} trials/variant={N} base={REF} prompt x{TURNS}')
for v in P:
    rows = [r for r in out if r[0] == v]
    print(f' variant {v}: pass {sum(r[4] for r in rows)}/{N} | mean edit turns {sum(sum(r[1]) for r in rows)/N:.1f}/{TURNS} | '
          f'one-line replies {sum(sum(r[2]) for r in rows)}/{N*TURNS} (per turn: ' + ' '.join(str(sum(r[2][t] for r in rows)) for t in range(TURNS)) + f' of {N}) | mean changed lines {sum(r[3] for r in rows)/N:.1f}')
