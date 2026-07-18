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
# Ceiling on the critical-gate bypass (see _middle_has_excess_errors below): a
# dense-error output only skips compression entirely if it's still small.
# Above this, letting it through whole would defeat the compressor's whole
# purpose — fall back to elision + capped salvage instead.
GATE_MAX_CHARS = int(os.environ.get("COMB_COMPRESS_GATE_MAX", "20000"))
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
    have to drop some."""
    return _scan_errors(middle)[0]


def _salvage_error_lines(middle: str) -> List[str]:
    return _scan_errors(middle)[1]


def _scan_errors(middle: str) -> tuple[bool, List[str]]:
    """Single-pass merge of _middle_has_excess_errors + _salvage_error_lines
    (ported from scripts/compress-tool-output.js's scanErrors -- see that
    file for the profiling numbers and the gate-ceiling bug this shape
    guards against). One split + one regex loop instead of two.

    kept is ALWAYS the first MAX_ERROR_LINES deduped matches, independent
    of excess -- compress() only uses excess to decide whether to bail out
    entirely; when it doesn't bail (dense errors past GATE_MAX_CHARS),
    salvage still needs its normal capped list.
    """
    seen = set()
    kept: List[str] = []
    excess = False
    for line in middle.split("\n"):
        if not _ERROR_PATTERN.search(line) or line in seen:
            continue
        seen.add(line)
        if len(kept) < MAX_ERROR_LINES:
            kept.append(line)
        if len(seen) > MAX_ERROR_LINES:
            excess = True
            break
    return excess, kept


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
        excess, error_lines = _scan_errors(middle)
        # TACO-style critical gate: too many error lines to salvage safely --
        # leave the whole output untouched, but only below GATE_MAX_CHARS.
        # Past that, a huge dense-error blob still needs elision, just with
        # the existing salvage cap.
        if excess and len(text) <= GATE_MAX_CHARS:
            return None

    marker = f"\n… [comb: elided {len(text) - HEAD_CHARS - TAIL_CHARS} chars"
    if error_lines:
        marker += f", {len(error_lines)} error line(s) kept below"
    marker += "] …\n"
    error_block = ("\n".join(error_lines) + "\n") if error_lines else ""

    return head + marker + error_block + tail


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
