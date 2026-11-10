import logging

log = logging.getLogger(__name__)


def drop_duplicates(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in rows:
        if r["raw"] not in seen:
            seen.add(r["raw"])
            out.append(r)
    log.info("dropped %d duplicate rows", len(rows) - len(out))
    return out
