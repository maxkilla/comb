#!/bin/bash
# comb — statusline badge for Claude Code
#
# Usage in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "bash /path/to/comb-statusline.sh" }

# Drain Claude's statusline JSON from stdin (carries rate_limits.* — the same
# 5h/weekly figures /usage shows). Read before any early exit so the pipe closes.
INPUT=$(cat)

# Pure grep scoping (no jq/node dep): each window object has no nested braces, and
# the final [0-9] extract guarantees a digits-only value — no escape injection.
scope() {   # $1 = window key, $2 = inner field → digits only, or empty
  printf '%s' "$INPUT" | grep -oE "\"$1\":\{[^}]*\}" \
    | grep -oE "\"$2\":[0-9.]+" | grep -oE '[0-9.]+' | head -1
}
# Eighth-block glyphs for sub-cell fill precision (index 1-7; 0 unused, 8 is a
# full █ cell). Gives an 8-cell bar 64 distinct fill levels instead of 10.
EIGHTHS=(' ' '▏' '▎' '▍' '▌' '▋' '▊' '▉')
BAR_WIDTH=8

color_for_pct() {  # $1 = integer pct → 256-color ANSI code, traffic-light gradient
  local p=$1
  if   [ "$p" -ge 80 ]; then printf '196'  # red — near/at limit
  elif [ "$p" -ge 50 ]; then printf '178'  # yellow — over half
  else printf '76'; fi                     # green — plenty of headroom
}
bar() {     # $1 = integer pct → BAR_WIDTH-cell colored bar, smooth eighth-block fill
  local p=$1
  local eighths=$(( p * BAR_WIDTH * 8 / 100 )) full rem out="" i color
  [ "$eighths" -gt $(( BAR_WIDTH * 8 )) ] && eighths=$(( BAR_WIDTH * 8 ))
  [ "$eighths" -lt 0 ] && eighths=0
  full=$(( eighths / 8 )); rem=$(( eighths % 8 ))
  color=$(color_for_pct "$p")
  for (( i = 0; i < full; i++ )); do out="${out}█"; done
  [ "$rem" -gt 0 ] && out="${out}${EIGHTHS[$rem]}"
  local empty=$(( BAR_WIDTH - full - (rem > 0 ? 1 : 0) ))
  local pad=""
  for (( i = 0; i < empty; i++ )); do pad="${pad}░"; done
  printf '\033[38;5;%sm%s\033[0m\033[38;5;238m%s\033[0m' "$color" "$out" "$pad"
}
until_str() {  # $1 = reset epoch → "3d4h"/"2h14m"/"12m", empty if past/absent
  [ -z "$1" ] && return
  local s d h m now; now=$(date +%s)
  s=$(( ${1%.*} - now )); [ "$s" -le 0 ] && return
  d=$(( s/86400 )); h=$(( (s%86400)/3600 )); m=$(( (s%3600)/60 ))
  if   [ "$d" -gt 0 ]; then printf '%dd%dh' "$d" "$h"
  elif [ "$h" -gt 0 ]; then printf '%dh%dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}
seg() {     # $1 = label, $2 = window key → " Label: <bar> NN% ⟳<until>"  (empty if no data)
  local pct u
  pct=$(scope "$2" used_percentage); pct=${pct%.*}
  [ -z "$pct" ] && return
  u=$(until_str "$(scope "$2" resets_at)")
  printf ' %s: %s %s%%%s' "$1" "$(bar "$pct")" "$pct" "${u:+ ⟳$u}"
}

S=$(seg Session five_hour)
W=$(seg Weekly seven_day)
LIMITS="$S"
[ -n "$W" ] && LIMITS="${LIMITS}${LIMITS:+ │}$W"

# API-key users get no rate_limits in stdin — fall back to session cost.
# Plan users pay no per-token cost, so show it only when no limits rendered.
# LC_NUMERIC=C forces '.' decimal so printf parses the JSON float in any locale.
if [ -z "$LIMITS" ]; then
  COST=$(scope cost total_cost_usd)
  [ -n "$COST" ] && LIMITS=$(LC_NUMERIC=C printf ' Session: $%.2f' "$COST")
fi

# Cumulative savings from the tool-output compressor ledger
# (scripts/compress-tool-output.js recordSavings). Char count (SAVED) is
# measured exactly. The token figure below is NOT measured -- it's the
# standard ~4-chars-per-token approximation, hence the leading '~'. Don't
# drop that marker; a precise-looking token count next to real dollar/limit
# figures elsewhere on this line would be a silently wrong claim.
# Digits-only extract; symlink-refused before reading.
STATS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/comb/stats.json"
if [ -f "$STATS" ] && [ ! -L "$STATS" ]; then
  SAVED=$(head -c 256 "$STATS" 2>/dev/null | grep -oE '"savedChars":[0-9]+' | grep -oE '[0-9]+' | head -1)
  EVENTS=$(head -c 256 "$STATS" 2>/dev/null | grep -oE '"events":[0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ -n "$SAVED" ] && [ "$SAVED" -gt 0 ] 2>/dev/null; then
    TOK=$(( SAVED / 4 ))
    if   [ "$TOK" -ge 1000000 ]; then LIMITS="$LIMITS ⇣~$(( TOK / 1000000 ))M tok"
    elif [ "$TOK" -ge 1000 ];    then LIMITS="$LIMITS ⇣~$(( TOK / 1000 ))k tok"
    elif [ "$TOK" -gt 0 ];       then LIMITS="$LIMITS ⇣~${TOK} tok"; fi
    [ -n "$EVENTS" ] && [ "$EVENTS" -gt 0 ] 2>/dev/null && LIMITS="$LIMITS (${EVENTS}x)"
  fi
fi

# Green badge (distinct from rdxmin's orange), stats trailing outside the bracket
printf '\033[38;5;35m[COMB]\033[0m%s' "$LIMITS"
