"""Predictable transcript formatting without a language model or network call."""

import re
import unicodedata


ROLE_PREFIX = re.compile(r"^\s*(Moderator|Responder)\s*:\s*", re.IGNORECASE)
SENTENCE_START = re.compile(r"(^|[.!?]\s+)([^\W\d_])", re.UNICODE)


def format_line(line: str) -> str:
    line = unicodedata.normalize("NFC", line)
    role = ROLE_PREFIX.match(line)
    prefix = f"{role.group(1).capitalize()}: " if role else ""
    body = line[role.end() :] if role else line
    body = re.sub(r"\s+", " ", body).strip()
    body = re.sub(r"\s+([,.;:!?])", r"\1", body)
    body = re.sub(r"([,;:!?])(?=[^\s\d])", r"\1 ", body)
    body = re.sub(r"(?<!\d)\.(?=[^\s\d])", ". ", body)
    body = SENTENCE_START.sub(lambda match: match.group(1) + match.group(2).upper(), body)
    if body and body[-1] not in ".!?":
        body += "."
    return prefix + body if body else prefix.rstrip()


def format_transcript(text: str) -> str:
    """Fix spacing and sentence capitalization while preserving speaker lines."""
    return "\n".join(format_line(line) for line in text.splitlines()).strip()
