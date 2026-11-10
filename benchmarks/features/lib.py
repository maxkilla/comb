"""Shared helpers for the feature A/B harnesses (headless `claude -p`, needs the claude CLI).
Variant A = persona from git ref (default main), B = persona from the working tree.
Run from anywhere; each trial gets its own temp copy of the fixture repo."""
import json, os, shutil, subprocess, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

def persona(ref=None):
    """The additionalContext the UserPromptSubmit hook injects. ref=None -> working tree."""
    if ref:
        src = subprocess.run(['git', '-C', ROOT, 'show', f'{ref}:scripts/inject-comb-mode.js'], capture_output=True, text=True, check=True).stdout
        p = tempfile.NamedTemporaryFile('w', suffix='.js', delete=False); p.write(src); p.close()
        path = p.name
    else:
        path = os.path.join(ROOT, 'scripts', 'inject-comb-mode.js')
    out = subprocess.run(['node', path], capture_output=True, text=True, check=True).stdout
    if ref: os.unlink(path)
    return json.loads(out)['hookSpecificOutput']['additionalContext']

TOOLS = 'Read,Grep,Glob,Write,Edit,Bash(rg:*),Bash(grep:*),Bash(ls:*),Bash(cat:*),Bash(python3:*)'

def run_turns(fixture, prompts, system, model='sonnet', timeout=600):
    """Copy fixture to a temp dir, run prompts as one resumed session. Returns (workdir, [reply per turn])."""
    wd = tempfile.mkdtemp(prefix='comb-feat-')
    shutil.copytree(fixture, wd, dirs_exist_ok=True)
    replies, sid = [], None
    for p in prompts:
        cmd = ['claude', '-p', p, '--model', model, '--output-format', 'json', '--allowedTools', TOOLS,
               '--permission-mode', 'acceptEdits', '--append-system-prompt', system]
        if sid: cmd += ['--resume', sid]
        r = subprocess.run(cmd, cwd=wd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=timeout)
        try:
            j = json.loads(r.stdout); sid = j.get('session_id', sid); replies.append(j.get('result', ''))
        except Exception:
            replies.append(r.stdout + r.stderr)
    return wd, replies
