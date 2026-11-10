import logging

log = logging.getLogger(__name__)


def to_csv(rows: list[dict], path: str) -> None:
    log.info("writing %d rows to %s", len(rows), path)
    with open(path, "w") as f:
        for r in rows:
            f.write(r["raw"] + "\n")
