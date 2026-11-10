#!/usr/bin/env python3
"""C1 test: per-turn reuse check. Repo has utils.slugify(). Three turns each need a slug.
A = persona at git ref (default main), B = working tree. Per turn, pass = new file imports/uses
utils.slugify and does not re-implement slug logic (no `def slugify`, no re.sub on lowercased text).
Usage: python3 run.py [N=4] [model=sonnet] [base_ref=main]"""
import os, re, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import lib
here = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 4
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'sonnet'
REF = sys.argv[3] if len(sys.argv) > 3 else 'main'
P = {'A': lib.persona(REF), 'B': lib.persona()}
TURNS = [
  ('posts.py', 'Add posts.py with make_post_url(title) that returns "/posts/<slug>" for a post title.'),
  ('tags.py', 'Add tags.py with tag_url(tag) that returns "/tags/<slug>" for a tag name.'),
  ('authors.py', 'Add authors.py with author_profile_path(name) that returns "/u/<slug>" for an author name.'),
]
def trial(a):
    v, i = a
    wd, _ = lib.run_turns(os.path.join(here, 'fixture'), [t[1] for t in TURNS], P[v], MODEL)
    res = []
    for fn, _ in TURNS:
        p = os.path.join(wd, fn)
        src = open(p).read() if os.path.exists(p) else ''
        uses = bool(re.search(r'from\s+utils\s+import[^\n]*\bslugify\b|import\s+utils\b', src)) and 'slugify' in src
        reimpl = bool(re.search(r'def\s+\w*slug\w*\s*\(|re\.sub\(|\.lower\(\)\.replace\(', src))
        res.append(bool(src) and uses and not reimpl)
    return v, i, res
jobs = [(v, i) for v in P for i in range(N)]
with ThreadPoolExecutor(6) as ex: out = list(ex.map(trial, jobs))
print(f'model={MODEL} trials/variant={N} base={REF}')
for v in P:
    rows = [r for vv, _, r in out if vv == v]
    per = [sum(r[t] for r in rows) for t in range(len(TURNS))]
    print(f' variant {v}: reuse per turn ' + '  '.join(f'{TURNS[t][0]} {per[t]}/{N}' for t in range(len(TURNS))) +
          f'  | all three turns {sum(all(r) for r in rows)}/{N}')
