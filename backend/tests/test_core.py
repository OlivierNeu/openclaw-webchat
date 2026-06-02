import asyncio
import json
import os
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException

from app import auth as auth_module
from app.config import load_config, resolve_user_target
from app.main import (
    _authenticate_websocket,
    _extract_run_id,
    _handle_abort,
    _handle_send,
    _history_limit,
    _openclaw_to_browser,
    _send_chat_message,
)
from app.normalizer import Normalizer
from app.openclaw_client import (
    OpenClawConnection,
    OpenClawError,
    idempotency_key,
    normalize_ws_url,
)
from app.sanitizer import (
    MediaConfigurationError,
    media_fingerprint,
    media_signature,
    sanitize_frame,
    sanitize_text,
)
from app.session_keys import build_session_key


def test_build_session_key_sanitizes_parts():
    assert (
        build_session_key("alice", "alice.smith@example.com", "chat:1 / x")
        == "agent:alice:webchat:chat:alice.smith-example.com:chat-1-x"
    )


def test_sanitize_text_removes_visible_outbound_path_label():
    text = (
        "Voici le fichier:\n"
        "Path : `/home/node/.openclaw/media/outbound/HINDSIGHT-GUIDE.pdf`\n"
        "OK"
    )
    assert sanitize_text(text) == "Voici le fichier:\nOK"


def test_sanitize_text_masks_media_directive_path(monkeypatch):
    monkeypatch.setenv("OPENCLAW_MEDIA_LINK_SECRET", "test-media-secret")
    monkeypatch.delenv("OPENCLAW_WEBCHAT_PUBLIC_BASE_URL", raising=False)
    text = "MEDIA:/home/node/.openclaw/media/outbound/file final.pdf"
    sanitized = sanitize_text(text, media_session_key="session-key")

    assert "/home/node/.openclaw" not in sanitized
    assert sanitized.startswith(
        "[file final.pdf](/api/media/outbound/file%20final.pdf?scope="
    )
    assert "&exp=" in sanitized
    assert "&fp=" in sanitized
    assert "&sig=" in sanitized


def test_sanitize_frame_converts_media_urls_to_signed_links(monkeypatch):
    monkeypatch.setenv("OPENCLAW_MEDIA_LINK_SECRET", "test-media-secret")
    monkeypatch.delenv("OPENCLAW_WEBCHAT_PUBLIC_BASE_URL", raising=False)
    frame = {
        "event": "agent",
        "payload": {
            "data": {
                "mediaUrls": [
                    "/home/node/.openclaw/media/outbound/file final.pdf"
                ]
            }
        },
    }

    sanitized = sanitize_frame(frame, media_session_key="session-key")
    media_url = sanitized["payload"]["data"]["mediaUrls"][0]

    assert "/home/node/.openclaw" not in media_url
    assert media_url.startswith(
        "[file final.pdf](/api/media/outbound/file%20final.pdf?scope="
    )
    assert "&exp=" in media_url
    assert "&fp=" in media_url
    assert "&sig=" in media_url


def test_sanitize_frame_uses_public_base_url_for_media_links(monkeypatch):
    monkeypatch.setenv("OPENCLAW_MEDIA_LINK_SECRET", "test-media-secret")
    monkeypatch.setenv(
        "OPENCLAW_WEBCHAT_PUBLIC_BASE_URL",
        "wss://openclaw-webchat-api.example.com/",
    )
    frame = {
        "payload": {
            "data": {
                "mediaUrls": [
                    "/home/node/.openclaw/media/outbound/report.pdf"
                ]
            }
        }
    }

    sanitized = sanitize_frame(frame, media_session_key="session-key")
    media_url = sanitized["payload"]["data"]["mediaUrls"][0]

    assert media_url.startswith(
        "[report.pdf](https://openclaw-webchat-api.example.com"
        "/api/media/outbound/report.pdf?scope="
    )
    assert "&exp=" in media_url
    assert "&fp=" in media_url
    assert "&sig=" in media_url


def test_media_signature_is_session_scoped_and_file_bound(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENCLAW_MEDIA_LINK_SECRET", "test-media-secret")
    monkeypatch.setenv("OPENCLAW_MEDIA_OUTBOUND_DIR", str(tmp_path))
    media = tmp_path / "report.pdf"
    media.write_text("v1")

    sanitized = sanitize_frame(
        {
            "payload": {
                "data": {
                    "mediaUrls": [
                        "/home/node/.openclaw/media/outbound/report.pdf"
                    ]
                }
            }
        },
        media_session_key="session-a",
    )
    media_link = sanitized["payload"]["data"]["mediaUrls"][0]
    url = media_link.removeprefix("[report.pdf](").removesuffix(")")
    query = parse_qs(urlparse(url).query, keep_blank_values=True)

    assert query["fp"] == [media_fingerprint("report.pdf")]
    assert media_signature(
        "report.pdf",
        query["scope"][0],
        query["exp"][0],
        query["fp"][0],
    ) == query["sig"][0]


def test_media_signature_requires_shared_secret(monkeypatch):
    monkeypatch.delenv("OPENCLAW_MEDIA_LINK_SECRET", raising=False)

    with pytest.raises(MediaConfigurationError):
        media_signature("file.pdf")


def test_sanitize_text_preserves_streaming_delta_spaces():
    assert sanitize_text(" world") == " world"
    assert sanitize_text(" ") == " "
    assert sanitize_text("\n") == "\n"


def test_normalize_ws_url():
    assert normalize_ws_url("10.0.0.5:18789") == "ws://10.0.0.5:18789"
    assert normalize_ws_url("http://x:1") == "ws://x:1"
    assert normalize_ws_url("https://x") == "wss://x"


def test_idempotency_key_is_stable_for_client_message():
    first = idempotency_key("session", "message-id")
    second = idempotency_key("session", "message-id")
    assert first == second
    assert first.startswith("webchat-")


def test_resolve_user_target_from_env_config(monkeypatch):
    identity = {
        "id": "device",
        "publicKey": "public",
        "privateKey": "private",
    }
    config = {
        "instances": {
            "olivier": {
                "url": "ws://gateway:18789",
                "tokenEnv": "OPENCLAW_TEST_TOKEN",
                "deviceIdentityEnv": "OPENCLAW_TEST_IDENTITY",
            }
        },
        "users": {
            "alice@example.com": {
                "instance": "olivier",
                "agentId": "alice",
                "canonical": "alice",
                "displayName": "Alice",
            }
        },
    }
    monkeypatch.setenv("OPENCLAW_WEBCHAT_CONFIG", json.dumps(config))
    monkeypatch.setenv("OPENCLAW_TEST_TOKEN", "secret")
    monkeypatch.setenv("OPENCLAW_TEST_IDENTITY", json.dumps(identity))

    target = resolve_user_target(
        load_config(),
        "Alice@Example.com",
        "chat-1",
    )

    assert target.email == "alice@example.com"
    assert target.sessionKey == "agent:alice:webchat:chat:alice:chat-1"
    assert target.token == "secret"
    assert target.deviceIdentity == identity


def test_resolve_user_target_rejects_unmapped_user(monkeypatch):
    monkeypatch.setenv(
        "OPENCLAW_WEBCHAT_CONFIG",
        json.dumps({"instances": {}, "users": {}}),
    )
    with pytest.raises(RuntimeError):
        resolve_user_target(load_config(), "unknown@example.com", "chat")


def test_resolve_user_target_enforces_allowed_chat_prefixes(monkeypatch):
    config = {
        "instances": {
            "alice": {
                "url": "ws://gateway:18789",
                "tokenEnv": "OPENCLAW_TEST_TOKEN",
                "deviceIdentityEnv": "OPENCLAW_TEST_IDENTITY",
            }
        },
        "users": {
            "alice@example.com": {
                "instance": "alice",
                "agentId": "alice",
                "canonical": "alice",
                "displayName": "Alice",
                "allowedChatPrefixes": ["team-"],
            }
        },
    }
    monkeypatch.setenv("OPENCLAW_WEBCHAT_CONFIG", json.dumps(config))
    monkeypatch.setenv("OPENCLAW_TEST_TOKEN", "secret")
    monkeypatch.setenv(
        "OPENCLAW_TEST_IDENTITY",
        json.dumps({"id": "d", "publicKey": "p", "privateKey": "k"}),
    )

    # A matching prefix is accepted.
    target = resolve_user_target(load_config(), "alice@example.com", "team-42")
    assert target.sessionKey.endswith("team-42")

    # A non-matching chatId is rejected.
    with pytest.raises(RuntimeError):
        resolve_user_target(load_config(), "alice@example.com", "private-99")


def test_history_limit_rejects_invalid_values():
    with pytest.raises(HTTPException) as exc:
        _history_limit("abc")

    assert exc.value.status_code == 400


def test_history_limit_bounds_valid_values():
    assert _history_limit(None) == 200
    assert _history_limit("2") == 2
    assert _history_limit("9999") == 500


@pytest.mark.asyncio
async def test_send_chat_message_requests_verbose_before_send():
    class FakeConnection:
        def __init__(self):
            self.calls = []

        async def request(self, method, params, timeout=30):
            self.calls.append((method, params, timeout))
            return {"ok": True, "method": method}

    conn = FakeConnection()
    response = await _send_chat_message(
        conn,
        "session-key",
        {"sessionKey": "session-key", "message": "hello"},
    )

    assert response == {"ok": True, "method": "chat.send"}
    assert conn.calls == [
        (
            "sessions.patch",
            {"key": "session-key", "verboseLevel": "full"},
            10,
        ),
        (
            "chat.send",
            {"sessionKey": "session-key", "message": "hello"},
            20,
        ),
    ]


@pytest.mark.asyncio
async def test_invalid_firebase_token_returns_401(monkeypatch):
    def fake_verify_id_token(token, check_revoked=True):
        raise ValueError("expired")

    monkeypatch.setattr(auth_module, "_init_firebase", lambda: None)
    monkeypatch.setattr(
        auth_module.firebase_auth,
        "verify_id_token",
        fake_verify_id_token,
    )

    with pytest.raises(HTTPException) as exc:
        await auth_module.verify_bearer_token("invalid-token")

    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_unverified_firebase_email_returns_401(monkeypatch):
    def fake_verify_id_token(token, check_revoked=True):
        return {
            "email": "alice@example.com",
            "email_verified": False,
            "uid": "uid-1",
        }

    monkeypatch.setattr(auth_module, "_init_firebase", lambda: None)
    monkeypatch.setattr(
        auth_module.firebase_auth,
        "verify_id_token",
        fake_verify_id_token,
    )

    with pytest.raises(HTTPException) as exc:
        await auth_module.verify_bearer_token("unverified-token")

    assert exc.value.status_code == 401


class _FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.closed_code = None

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self, code=1000):
        self.closed_code = code


class _FakeConnection:
    def __init__(self):
        self.events = asyncio.Queue()
        self.calls = []

    async def request(self, method, params, timeout=30):
        self.calls.append((method, params, timeout))
        return {"ok": True, "method": method}


@pytest.mark.asyncio
async def test_openclaw_bridge_error_is_forwarded_and_closed():
    websocket = _FakeWebSocket()
    conn = _FakeConnection()
    normalizer = Normalizer("session", lambda name: None)
    await conn.events.put({"type": "bridge.error", "message": "upstream failed"})

    await _openclaw_to_browser(websocket, conn, "session", normalizer)

    assert websocket.sent == [
        {"type": "bridge.error", "message": "upstream failed", "fatal": True}
    ]
    assert websocket.closed_code == 1011


@pytest.mark.asyncio
async def test_loop_forwards_own_frames_and_drops_foreign():
    websocket = _FakeWebSocket()
    conn = _FakeConnection()
    normalizer = Normalizer("session", lambda name: None)
    loop = asyncio.get_running_loop()
    normalizer.begin_turn(loop.time())
    normalizer.note_run_started("run-x", loop.time())
    # Foreign session frame (must be dropped), then an own delta, then close.
    await conn.events.put(
        {
            "event": "agent",
            "payload": {
                "sessionKey": "other",
                "stream": "assistant",
                "data": {"delta": "foreign content"},
            },
        }
    )
    await conn.events.put(
        {
            "event": "chat",
            "payload": {
                "sessionKey": "session",
                "runId": "run-x",
                "state": "delta",
                "deltaText": "own content",
            },
        }
    )
    await conn.events.put({"type": "bridge.error", "message": "done"})

    await _openclaw_to_browser(websocket, conn, "session", normalizer)

    serialized = json.dumps(websocket.sent)
    assert "foreign content" not in serialized
    deltas = [
        e for e in websocket.sent
        if e.get("type") == "message.delta" and e.get("text") == "own content"
    ]
    assert deltas, "own deltaText must reach the browser as a normalized event"
    assert websocket.closed_code == 1011


@pytest.mark.asyncio
async def test_send_chat_message_applies_verbose_full_only_once():
    conn = _FakeConnection()
    await _send_chat_message(conn, "session-key", {"sessionKey": "session-key"})
    await _send_chat_message(conn, "session-key", {"sessionKey": "session-key"})
    patch_calls = [c for c in conn.calls if c[0] == "sessions.patch"]
    send_calls = [c for c in conn.calls if c[0] == "chat.send"]
    assert len(patch_calls) == 1  # verboseLevel=full applied once per connection
    assert len(send_calls) == 2


@pytest.mark.asyncio
async def test_handle_abort_finalizes_turn_and_sanitizes_result():
    websocket = _FakeWebSocket()
    normalizer = Normalizer("session", lambda name: None)
    loop = asyncio.get_running_loop()
    normalizer.begin_turn(loop.time())

    class AbortConn:
        async def request(self, method, params, timeout=30):
            return {
                "ok": True,
                "payload": {
                    "note": "stopped at /home/node/.openclaw/media/outbound/x.pdf"
                },
            }

    import os

    os.environ["OPENCLAW_MEDIA_LINK_SECRET"] = "test-media-secret"
    await _handle_abort(websocket, AbortConn(), "session", normalizer, loop.time())

    serialized = json.dumps(websocket.sent)
    assert "/home/node/.openclaw" not in serialized  # server path never leaks
    assert any(
        e.get("type") == "run.status" and e.get("status") == "aborted"
        for e in websocket.sent
    )
    assert any(e.get("type") == "chat.abort.result" for e in websocket.sent)


@pytest.mark.asyncio
async def test_handle_send_failure_is_contained_without_closing_socket():
    websocket = _FakeWebSocket()
    normalizer = Normalizer("session", lambda name: None)
    loop = asyncio.get_running_loop()

    class FailingConn:
        async def request(self, method, params, timeout=30):
            raise OpenClawError("chat.send timed out")

    await _handle_send(
        websocket,
        FailingConn(),
        "session",
        normalizer,
        {"type": "chat.send", "message": "hi", "clientMessageId": "c1"},
        loop,
    )

    assert websocket.closed_code is None  # socket stays open, message preserved
    errors = [e for e in websocket.sent if e.get("type") == "bridge.error"]
    assert errors and errors[0].get("fatal") is False
    assert any(
        e.get("type") == "run.status" and e.get("status") == "error"
        for e in websocket.sent
    )


@pytest.mark.asyncio
async def test_websocket_auth_timeout_returns_401():
    class FakeWebSocket:
        query_params = {}
        headers = {}

        async def receive_json(self):
            raise asyncio.TimeoutError()

    with pytest.raises(HTTPException) as exc:
        await _authenticate_websocket(FakeWebSocket())

    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_openclaw_connect_wraps_gateway_connection_failure(monkeypatch):
    class FakeWebsockets:
        @staticmethod
        async def connect(*args, **kwargs):
            raise OSError("connection refused")

    monkeypatch.setattr("app.openclaw_client.websockets", FakeWebsockets)

    with pytest.raises(OpenClawError) as exc:
        await OpenClawConnection.connect(
            "ws://gateway",
            "token",
            {"id": "device", "publicKey": "public", "privateKey": "private"},
        )

    assert "connection failed" in str(exc.value)


@pytest.mark.asyncio
async def test_openclaw_connect_closes_socket_on_handshake_timeout(monkeypatch):
    class FakeOpenClawSocket:
        def __init__(self):
            self.closed = False

        async def recv(self):
            raise asyncio.TimeoutError()

        async def close(self):
            self.closed = True

    fake_ws = FakeOpenClawSocket()

    class FakeWebsockets:
        @staticmethod
        async def connect(*args, **kwargs):
            return fake_ws

    monkeypatch.setattr("app.openclaw_client.websockets", FakeWebsockets)

    with pytest.raises(OpenClawError):
        await OpenClawConnection.connect(
            "ws://gateway",
            "token",
            {"id": "device", "publicKey": "public", "privateKey": "private"},
        )

    assert fake_ws.closed is True


@pytest.mark.asyncio
async def test_openclaw_request_cleans_pending_when_send_fails():
    class FakeOpenClawSocket:
        async def send(self, raw):
            raise RuntimeError("closed")

    conn = OpenClawConnection(FakeOpenClawSocket())

    with pytest.raises(RuntimeError):
        await conn.request("chat.history", {"sessionKey": "session"})

    assert conn._pending == {}


@pytest.mark.asyncio
async def test_openclaw_reader_reports_clean_gateway_close():
    class FakeOpenClawSocket:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    conn = OpenClawConnection(FakeOpenClawSocket())
    loop = asyncio.get_running_loop()
    pending = loop.create_future()
    conn._pending["req-1"] = pending

    await conn._reader()

    event = await conn.events.get()
    assert event["type"] == "bridge.error"
    assert "closed" in event["message"].lower()
    assert conn._pending == {}
    assert pending.done()


@pytest.mark.asyncio
async def test_openclaw_request_timeout_raises_openclaw_error():
    class FakeOpenClawSocket:
        async def send(self, raw):
            return None

    conn = OpenClawConnection(FakeOpenClawSocket())

    with pytest.raises(OpenClawError):
        await conn.request("chat.history", {"sessionKey": "session"}, timeout=0.01)

    assert conn._pending == {}
