#!/usr/bin/env python3
"""C3 test: existing code beats stale docs. CLAUDE.md says print(), no logging; every module uses logging.
Ask for a small feature. A = persona at git ref (default main), B = working tree.
Pass = new module uses logging, has no print(), existing modules untouched, and the reply lists the conflict
(mentions CLAUDE.md plus print/logging).
Usage: python3 run.py [N=6] [model=sonnet] [base_ref=main]"""
import hashlib, os, re, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import lib
here = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'sonnet'
REF = sys.argv[3] if len(sys.argv) > 3 else 'main'
P = {'A': lib.persona(REF), 'B': lib.persona()}
PROMPT = 'Add app/purge.py with purge_blank(rows) that drops rows whose "raw" is blank and reports how many it dropped.'
EXISTING = ['app/store.py', 'app/export.py', 'app/dedupe.py']
def h(wd): return [hashlib.md5(open(os.path.join(wd, f), 'rb').read()).hexdigest() for f in EXISTING]
base_h = h(os.path.join(here, 'fixture'))
def trial(a):
    v, i = a
    wd, replies = lib.run_turns(os.path.join(here, 'fixture'), [PROMPT], P[v], MODEL)
    p = os.path.join(wd, 'app', 'purge.py'); src = open(p).read() if os.path.exists(p) else ''
    logging_used = bool(re.search(r'\blogging\b|\blog(ger)?\.(info|debug|warning)', src))
    no_print = 'print(' not in src
    untouched = h(wd) == base_h
    reply = replies[-1]
    lists = bool(re.search(r'CLAUDE\.md', reply)) and bool(re.search(r'print', reply, re.I)) and bool(re.search(r'logging', reply, re.I))
    return v, dict(code=bool(src) and logging_used and no_print, untouched=untouched, lists=lists)
jobs = [(v, i) for v in P for i in range(N)]
with ThreadPoolExecutor(6) as ex: out = list(ex.map(trial, jobs))
print(f'model={MODEL} trials/variant={N} base={REF}')
for v in P:
    rows = [r for vv, r in out if vv == v]
    print(f' variant {v}: new code uses logging, no print {sum(r["code"] for r in rows)}/{N} | existing files untouched {sum(r["untouched"] for r in rows)}/{N} | reply lists conflict {sum(r["lists"] for r in rows)}/{N} | all three {sum(r["code"] and r["untouched"] and r["lists"] for r in rows)}/{N}')
