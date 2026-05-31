import re

_SAFE_PART_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def safe_session_part(value: str) -> str:
    cleaned = _SAFE_PART_RE.sub("-", value.strip())
    cleaned = cleaned.strip("-._")
    return cleaned or "unknown"


def build_session_key(agent_id: str, canonical: str, chat_id: str) -> str:
    return (
        f"agent:{safe_session_part(agent_id)}:"
        f"webchat:chat:{safe_session_part(canonical)}:"
        f"{safe_session_part(chat_id)}"
    )

