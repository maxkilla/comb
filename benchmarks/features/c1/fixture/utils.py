import re


def slugify(text: str) -> str:
    """Lowercase, collapse non-alphanumerics to single hyphens, trim hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def truncate(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"
