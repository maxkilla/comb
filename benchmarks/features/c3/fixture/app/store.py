import logging

log = logging.getLogger(__name__)


def load(path: str) -> list[dict]:
    log.info("loading %s", path)
    rows = []
    with open(path) as f:
        for line in f:
            rows.append({"raw": line.rstrip("\n")})
    log.debug("loaded %d rows", len(rows))
    return rows
