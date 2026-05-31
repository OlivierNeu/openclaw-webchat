from __future__ import annotations

import hashlib
import hmac
import os
import re
import time
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

_OUTBOUND_PATH_RE = re.compile(
    r"/home/node/\.openclaw/(?:media/outbound|workspace-[^\s`)>]+)"
    r"/([^\s`)>]+)"
)
_MEDIA_DIRECTIVE_RE = re.compile(
    r"^MEDIA:(/home/node/\.openclaw/media/outbound/(.+))$"
)
_MEDIA_OUTBOUND_PATH_RE = re.compile(
    r"^/home/node/\.openclaw/media/outbound/(.+)$"
)


class MediaConfigurationError(RuntimeError):
    pass


def _media_outbound_dir() -> Path:
    return Path(
        os.getenv(
            "OPENCLAW_MEDIA_OUTBOUND_DIR",
            "/home/node/.openclaw/media/outbound",
        )
    )


def _media_link_secret() -> str:
    secret = os.getenv("OPENCLAW_MEDIA_LINK_SECRET")
    if not secret:
        raise MediaConfigurationError(
            "OPENCLAW_MEDIA_LINK_SECRET must be set to a stable shared secret"
        )
    return secret


def media_scope(session_key: str) -> str:
    if not session_key:
        raise MediaConfigurationError("media links require a session key")
    return hmac.new(
        _media_link_secret().encode(),
        f"scope:{session_key}".encode(),
        hashlib.sha256,
    ).hexdigest()


def media_fingerprint(filename: str) -> str:
    if PurePosixPath(filename).name != filename:
        raise MediaConfigurationError("media links require a safe filename")
    path = _media_outbound_dir() / filename
    if not path.is_file():
        return ""
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def media_signature(
    filename: str,
    scope: str = "",
    expires_at: str = "",
    fingerprint: str = "",
) -> str:
    payload = "\0".join([filename, scope, expires_at, fingerprint])
    return hmac.new(
        _media_link_secret().encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()


def media_signature_valid(
    filename: str,
    signature: str,
    scope: str,
    expires_at: str,
    fingerprint: str,
) -> bool:
    if not scope or not expires_at or not signature:
        return False
    try:
        expires = int(expires_at)
    except ValueError:
        return False
    if expires < int(time.time()):
        return False
    if fingerprint != media_fingerprint(filename):
        return False
    expected = media_signature(filename, scope, expires_at, fingerprint)
    return hmac.compare_digest(expected, signature)


def _public_base_url() -> str:
    raw = os.getenv("OPENCLAW_WEBCHAT_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not raw:
        return ""
    if raw.startswith("wss://"):
        raw = "https://" + raw[len("wss://") :]
    elif raw.startswith("ws://"):
        raw = "http://" + raw[len("ws://") :]
    if not raw.startswith(("http://", "https://")):
        raise MediaConfigurationError(
            "OPENCLAW_WEBCHAT_PUBLIC_BASE_URL must be http(s) or ws(s)"
        )
    return raw


def _media_link_ttl_seconds() -> int:
    raw = os.getenv("OPENCLAW_MEDIA_LINK_TTL_SECONDS", "3600")
    try:
        ttl = int(raw)
    except ValueError as exc:
        raise MediaConfigurationError(
            "OPENCLAW_MEDIA_LINK_TTL_SECONDS must be an integer"
        ) from exc
    return max(60, min(ttl, 86400))


def media_url(filename: str, session_key: str) -> str:
    scope = media_scope(session_key)
    expires_at = str(int(time.time()) + _media_link_ttl_seconds())
    fingerprint = media_fingerprint(filename)
    signature = media_signature(filename, scope, expires_at, fingerprint)
    path = (
        f"/api/media/outbound/{quote(filename)}"
        f"?scope={quote(scope)}"
        f"&exp={quote(expires_at)}"
        f"&fp={quote(fingerprint)}"
        f"&sig={quote(signature)}"
    )
    return f"{_public_base_url()}{path}"


def media_link_from_path(path: str, media_session_key: str | None) -> str:
    match = _MEDIA_OUTBOUND_PATH_RE.match(path)
    if not match:
        return sanitize_text(path, media_session_key=media_session_key)
    if not media_session_key:
        raise MediaConfigurationError("media links require a session key")
    filename = PurePosixPath(match.group(1)).name
    return f"[{filename}]({media_url(filename, media_session_key)})"


def sanitize_media_urls(value: Any, media_session_key: str | None = None) -> Any:
    if isinstance(value, str):
        return media_link_from_path(value, media_session_key)
    if isinstance(value, list):
        return [sanitize_media_urls(item, media_session_key) for item in value]
    return sanitize_frame(value, media_session_key=media_session_key)


def _is_media_urls_key(key: Any) -> bool:
    return isinstance(key, str) and key in {"mediaUrls", "media_urls"}


_PATH_LABEL_RE = re.compile(
    r"^\s*(?:path|chemin)\s*:\s*`?"
    r"/home/node/\.openclaw/(?:media/outbound|workspace-[^`\s]+)"
    r"/[^`\s]+`?\s*$",
    re.IGNORECASE,
)


def sanitize_text(text: str, media_session_key: str | None = None) -> str:
    if "/home/node/.openclaw/" not in text:
        return text
    lines = []
    for line in text.splitlines():
        if line.startswith("MEDIA:"):
            match = _MEDIA_DIRECTIVE_RE.match(line)
            if match:
                if not media_session_key:
                    raise MediaConfigurationError("media links require a session key")
                filename = PurePosixPath(match.group(2)).name
                lines.append(f"[{filename}]({media_url(filename, media_session_key)})")
            else:
                lines.append(
                    _OUTBOUND_PATH_RE.sub(
                        lambda m: PurePosixPath(m.group(1)).name,
                        line,
                    )
                )
            continue
        if _PATH_LABEL_RE.match(line):
            continue
        lines.append(
            _OUTBOUND_PATH_RE.sub(lambda m: PurePosixPath(m.group(1)).name, line)
        )
    return "\n".join(lines)


def sanitize_frame(value: Any, media_session_key: str | None = None) -> Any:
    if isinstance(value, str):
        return sanitize_text(value, media_session_key=media_session_key)
    if isinstance(value, list):
        return [sanitize_frame(item, media_session_key=media_session_key) for item in value]
    if isinstance(value, dict):
        return {
            key: sanitize_media_urls(item, media_session_key=media_session_key)
            if _is_media_urls_key(key)
            else sanitize_frame(item, media_session_key=media_session_key)
            for key, item in value.items()
        }
    return value
