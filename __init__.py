"""comb tool-output compressor — Hermes ``transform_tool_result`` hook.

Port of comb's Claude Code PostToolUse hook (``scripts/compress-tool-output.js``).
Elides the middle of oversized tool output, keeping the head, the tail, and
any line that looks like an error. Deterministic, stdlib-only.

Unlike the Claude Code version, Hermes' ``transform_tool_result`` always
hands back a plain ``str`` (no per-tool response-shape guessing needed), so
this port skips the JS version's ``locateText``/``rebuild`` field-sniffing
entirely and just compresses the string.

Excludes read_file / write_file / patch / skill_manage (Hermes' equivalents
of Read/Edit/Write) — never touches those, same as the Claude Code hook's
matcher. Everything else (terminal, web_search, web_extract, delegate_task,
search_files, MCP tools, ...) is compressed when it exceeds the threshold.

Kill switch: COMB_COMPRESS=0 (or false/no/off) disables compression entirely
without touching config.yaml.
"""

from __future__ import annotations

import os
import re
import urllib.request
import urllib.error
import json
from typing import Any, Dict, List, Optional

# comb loads its config + secrets from /etc/comb (separate files per the
# project convention: cron_env holds non-secret settings like
# COMB_RULE_STORE_URL; env holds secrets like SUPABASE_DB_URL). Hermes does
# not auto-source these, and the rule-store server + warmer may need both --
# so source them here at import time. Fail-open: if the files are missing or
# a var is already set in the environment, nothing is overridden.
def _source_comb_env() -> None:
    for path in ("/etc/comb/env", "/etc/comb/cron_env"):
        try:
            with open(path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip()
                    # strip a trailing inline comment (only when not inside quotes)
                    if "#" in val and not val.startswith('"'):
                        val = val.split("#", 1)[0].strip()
                    # don't clobber an already-set env var
                    if key and key not in os.environ:
                        os.environ[key] = val
        except FileNotFoundError:
            pass


_source_comb_env()

def _disabled() -> bool:
    return os.environ.get("COMB_COMPRESS", "").strip().lower() in {"0", "false", "no", "off"}


HEAD_CHARS = int(os.environ.get("COMB_COMPRESS_HEAD", "1200"))
TAIL_CHARS = int(os.environ.get("COMB_COMPRESS_TAIL", "800"))
THRESHOLD = int(os.environ.get("COMB_COMPRESS_THRESHOLD", "3000"))
# Ceiling on the critical-gate bypass (see _middle_has_excess_errors below): a
# dense-error output only skips compression entirely if it's still small.
# Above this, letting it through whole would defeat the compressor's whole
# purpose — fall back to elision + capped salvage instead.
GATE_MAX_CHARS = int(os.environ.get("COMB_COMPRESS_GATE_MAX", "20000"))
MAX_ERROR_LINES = 15

# Optional rule-store lookup, tried before generic elision below. Unset
# COMB_RULE_STORE_URL and this whole path is skipped -- comb stays
# zero-dependency and zero-network by default, this is opt-in. Mirrors the
# Claude Code hook's rule-store integration (scripts/compress-tool-output.js).
RULE_STORE_TIMEOUT_MS = int(os.environ.get("COMB_RULE_STORE_TIMEOUT_MS", "500"))

# No \b around "error": word-boundary matching misses "ValueError",
# "TypeError", "KeyError", etc. Trades a little false-positive risk for not
# missing real ones.
_ERROR_PATTERN = re.compile(r"error|exception|traceback|fail(ed|ure)?|fatal|panic", re.IGNORECASE)

_EXCLUDED_TOOLS = {"read_file", "write_file", "patch", "skill_manage"}

def _looks_like_error(text: str) -> bool:
    # ponytail: cheap C-speed pre-filter (a few substring finds) before the
    # expensive IGNORECASE regex. Clean output skips the regex entirely (~9us
    # vs ~350us). Covers every keyword; regex still runs only on a hit.
    low = text.lower()  # noqa: one lowercase copy, far cheaper than IGNORECASE scan
    return (
        "error" in low
        or "exception" in low
        or "traceback" in low
        or "fatal" in low
        or "panic" in low
        or "fail" in low
    )



def _middle_has_excess_errors(middle: str) -> bool:
    """True if *middle* has more distinct error-looking lines than
    _salvage_error_lines can keep (MAX_ERROR_LINES) -- i.e. salvage would
    have to drop some. Early-exits once it's seen enough to know, same
    trick as _looks_like_error."""
    seen = set()
    for line in middle.split("\n"):
        if not _ERROR_PATTERN.search(line) or line in seen:
            continue
        seen.add(line)
        if len(seen) > MAX_ERROR_LINES:
            return True
    return False


def compress(text: str) -> Optional[str]:
    """Return a compressed version of *text*, or ``None`` if under threshold
    or if compression would silently drop error lines it can't fit in the
    salvage cap (TACO-style critical gate, arXiv:2604.19572)."""
    if len(text) <= THRESHOLD:
        return None

    head = text[:HEAD_CHARS]
    tail = text[-TAIL_CHARS:] if TAIL_CHARS else ""

    # ponytail: elide middle only when an error-looking line exists; otherwise
    # tail alone is enough. Cheap pre-filter skips the regex on clean output.
    error_lines: List[str] = []
    if _looks_like_error(text):
        middle = text[HEAD_CHARS: len(text) - TAIL_CHARS]
        # TACO-style critical gate: too many error lines to salvage safely --
        # leave the whole output untouched, but only below GATE_MAX_CHARS.
        # Past that, a huge dense-error blob still needs elision, just with
        # the existing salvage cap.
        if _middle_has_excess_errors(middle) and len(text) <= GATE_MAX_CHARS:
            return None
        error_lines = _salvage_error_lines(middle)

    marker = f"\n… [comb: elided {len(text) - HEAD_CHARS - TAIL_CHARS} chars"
    if error_lines:
        marker += f", {len(error_lines)} error line(s) kept below"
    marker += "] …\n"
    error_block = ("\n".join(error_lines) + "\n") if error_lines else ""

    return head + marker + error_block + tail


def _salvage_error_lines(middle: str) -> List[str]:
    seen = set()
    kept: List[str] = []
    for line in middle.split("\n"):
        if _ERROR_PATTERN.search(line) and line not in seen:
            seen.add(line)
            kept.append(line)
            if len(kept) >= MAX_ERROR_LINES:
                break
    return kept


def _try_rule_store(command: str, text: str) -> Optional[str]:
    """Best-effort rule-store lookup, tried before generic elision.

    Fails open on everything -- unset URL, network error, timeout, non-200,
    or "no rule matched" (server returns output unchanged) -- by returning
    None, which sends the caller to the existing generic elision. Must never
    be slower than RULE_STORE_TIMEOUT_MS or block the hook; tool-result
    transforms run in the hot path.
    """
    rule_store_url = os.environ.get("COMB_RULE_STORE_URL") or None
    if not rule_store_url:
        return None
    try:
        req = urllib.request.Request(
            f"{rule_store_url.rstrip('/')}/compress",
            data=json.dumps({"command": command, "output": text}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=RULE_STORE_TIMEOUT_MS / 1000.0) as resp:
            if resp.status != 200:
                return None
            data = json.loads(resp.read().decode("utf-8"))
        out = data.get("output")
        if not isinstance(out, str) or out == text:
            return None  # server returned nothing useful -> fall through
        return out
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError, TimeoutError):
        return None  # server down/slow/unreachable -- never block on this


def _on_transform_tool_result(
    tool_name: str = "",
    args: Optional[Dict[str, Any]] = None,
    result: Any = None,
    **_: Any,
) -> Optional[str]:
    if _disabled():
        return None
    if tool_name in _EXCLUDED_TOOLS:
        return None
    if not isinstance(result, str):
        return None

    # Best-effort command string for rule-store matching, same fail-safe
    # shape as the JS hook: guess common input fields, never throw, fall
    # back to tool_name so non-terminal tools still get a (likely no-match)
    # lookup rather than crashing.
    command = ""
    if isinstance(args, dict):
        command = args.get("command") or args.get("pattern") or args.get("url") or tool_name or ""
    else:
        command = tool_name or ""

    rule_store_result = _try_rule_store(command, result)
    if rule_store_result is not None:
        return rule_store_result
    return compress(result)


def register(ctx) -> None:
    ctx.register_hook("transform_tool_result", _on_transform_tool_result)
