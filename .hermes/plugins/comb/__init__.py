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
from typing import Any, Dict, List, Optional

def _disabled() -> bool:
    return os.environ.get("COMB_COMPRESS", "").strip().lower() in {"0", "false", "no", "off"}


HEAD_CHARS = int(os.environ.get("COMB_COMPRESS_HEAD", "1200"))
TAIL_CHARS = int(os.environ.get("COMB_COMPRESS_TAIL", "800"))
THRESHOLD = int(os.environ.get("COMB_COMPRESS_THRESHOLD", "3000"))
MAX_ERROR_LINES = 15

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
        # leave the whole output untouched rather than guess which matter.
        if _middle_has_excess_errors(middle):
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
    return compress(result)


def register(ctx) -> None:
    ctx.register_hook("transform_tool_result", _on_transform_tool_result)
