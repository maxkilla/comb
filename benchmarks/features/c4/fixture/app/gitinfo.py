import subprocess


def git_log(repo):
    out = subprocess.run(f"git -C {repo} log --oneline -n 20", shell=True, capture_output=True, text=True)
    return out.stdout.splitlines()


def git_status(repo):
    out = subprocess.run(f"git -C {repo} status --short", shell=True, capture_output=True, text=True)
    return out.stdout.splitlines()
