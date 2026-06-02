import asyncio
import os
from pathlib import Path
from typing import Any, Dict

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .auth import token_from_authorization, verify_bearer_token, verify_websocket_user
from .config import ConfigError, load_config, resolve_user_target
from .models import AuthenticatedUser
from .normalizer import Normalizer
from .openclaw_client import OpenClawConnection, OpenClawError, idempotency_key
from .sanitizer import (
    MediaConfigurationError,
    media_signature_valid,
    media_url,
    sanitize_frame,
)

_DEFAULT_HISTORY_LIMIT = 200
_MAX_HISTORY_LIMIT = 500
_APP_NAME = "openclaw-webchat-bridge"
_APP_VERSION = "0.1.0"
_BRIDGE_PROTOCOL_VERSION = "0.1"


def _allowed_origins() -> list[str]:
    raw = os.getenv("ALLOWED_ORIGINS", "*")
    origins = [item.strip() for item in raw.split(",") if item.strip()]
    return origins or ["*"]


app = FastAPI(title="OpenClaw WebChat Bridge", version=_APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


async def current_user(
    authorization: str | None = Header(default=None),
) -> AuthenticatedUser:
    return await verify_bearer_token(token_from_authorization(authorization))


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/capabilities")
async def capabilities() -> Dict[str, Any]:
    return {
        "name": _APP_NAME,
        "version": _APP_VERSION,
        "protocolVersion": _BRIDGE_PROTOCOL_VERSION,
        "transport": {
            "websocket": {
                "path": "/ws/chats/{chatId}",
                "auth": [
                    "initial auth message",
                    "query idToken",
                    "Authorization bearer header",
                ],
            },
            "http": {
                "health": "/health",
                "me": "/api/me",
                "capabilities": "/api/capabilities",
                "media": (
                    "/api/media/outbound/{filename}"
                    "?scope={scope}&exp={expiresAt}&fp={fingerprint}"
                    "&sig={signature}"
                ),
            },
        },
        "publicBaseUrl": os.getenv("OPENCLAW_WEBCHAT_PUBLIC_BASE_URL", ""),
        "features": {
            "firebaseAuth": True,
            "devAuth": os.getenv("ALLOW_DEV_AUTH", "").lower()
            in ("1", "true", "yes"),
            "multiInstanceRouting": True,
            "chatHistoryReconciliation": True,
            "signedMediaDownloads": True,
            "openclawVerboseToolEvents": True,
            "staticFrontendServing": _STATIC_DIR is not None,
        },
        "clientContract": {
            "websocketMessages": [
                "bridge.ready",
                "bridge.error",
                "bridge.warning",
                "chat.history",
                "chat.send.result",
                "chat.abort.result",
                "message.delta",
                "message.snapshot",
                "message.final",
                "run.status",
                "tool.status",
                "media",
                "openclaw.frame",
                "pong",
            ],
            "browserMessages": [
                "auth",
                "ping",
                "chat.history",
                "chat.send",
                "chat.abort",
            ],
        },
    }


@app.get("/api/me")
async def me(user: AuthenticatedUser = Depends(current_user)) -> Dict[str, Any]:
    return user.model_dump()


@app.get("/api/media/outbound/{filename}")
async def outbound_media(
    filename: str,
    scope: str,
    exp: str,
    fp: str,
    sig: str,
) -> FileResponse:
    if Path(filename).name != filename:
        raise HTTPException(status_code=400, detail="Invalid media filename")
    try:
        signature_valid = media_signature_valid(filename, sig, scope, exp, fp)
    except MediaConfigurationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not signature_valid:
        raise HTTPException(status_code=403, detail="Invalid media signature")
    media_dir = Path(
        os.getenv(
            "OPENCLAW_MEDIA_OUTBOUND_DIR",
            "/home/node/.openclaw/media/outbound",
        )
    )
    path = media_dir / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Media not found")
    return FileResponse(path, filename=filename)


def _media_resolver(session_key: str):
    def resolve(filename: str) -> str | None:
        try:
            return media_url(filename, session_key)
        except MediaConfigurationError:
            return None

    return resolve


def _safe_sanitize(value: Any, session_key: str) -> Any:
    """Sanitize an OpenClaw response before forwarding it to the browser.

    Never let a server path or media-config failure leak to the client.
    """
    try:
        return sanitize_frame(value, media_session_key=session_key)
    except MediaConfigurationError:
        return {"sanitized": False}


def _extract_run_id(response: Dict[str, Any]) -> str | None:
    payload = response.get("payload") if isinstance(response, dict) else None
    if isinstance(payload, dict) and payload.get("runId"):
        return str(payload["runId"])
    if isinstance(response, dict) and response.get("runId"):
        return str(response["runId"])
    return None


async def _safe_send_error(websocket: WebSocket, message: str, code: int) -> None:
    try:
        await websocket.send_json(
            {"type": "bridge.error", "message": message, "fatal": True}
        )
    except Exception:  # noqa: BLE001 - socket may already be gone
        pass
    try:
        await websocket.close(code=code)
    except Exception:  # noqa: BLE001
        pass


@app.websocket("/ws/chats/{chat_id}")
async def chat_websocket(websocket: WebSocket, chat_id: str) -> None:
    await websocket.accept()
    conn: OpenClawConnection | None = None
    try:
        user = await _authenticate_websocket(websocket)
        config = load_config()
        target = resolve_user_target(config, user.email, chat_id)
        conn = await OpenClawConnection.connect(
            target.gatewayUrl,
            target.token,
            target.deviceIdentity,
        )
        await websocket.send_json(
            {
                "type": "bridge.ready",
                "user": user.model_dump(),
                "target": {
                    "email": target.email,
                    "displayName": target.displayName,
                    "instanceName": target.instanceName,
                    "agentId": target.agentId,
                    "canonical": target.canonical,
                    "sessionKey": target.sessionKey,
                },
            }
        )
        normalizer = Normalizer(
            target.sessionKey, _media_resolver(target.sessionKey)
        )
        try:
            await _send_history(websocket, conn, target.sessionKey)
        except OpenClawError as exc:
            # A history fetch failure is non-fatal: the user can still chat.
            await websocket.send_json(
                {"type": "bridge.error", "message": str(exc), "fatal": False}
            )
        await _bridge_loop(websocket, conn, target.sessionKey, normalizer)
    except WebSocketDisconnect:
        pass
    except HTTPException as exc:
        await _safe_send_error(websocket, exc.detail, code=1008)
    except (ConfigError, OpenClawError) as exc:
        await _safe_send_error(websocket, str(exc), code=1011)
    except Exception as exc:  # noqa: BLE001 - never leave the browser hanging
        await _safe_send_error(
            websocket, f"Bridge internal error: {type(exc).__name__}", code=1011
        )
    finally:
        if conn is not None:
            await conn.close()


async def _authenticate_websocket(websocket: WebSocket) -> AuthenticatedUser:
    if websocket.query_params.get("idToken") or websocket.headers.get(
        "authorization"
    ):
        return await verify_websocket_user(websocket)
    try:
        message = await asyncio.wait_for(websocket.receive_json(), timeout=10)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=401, detail="Authentication timed out") from exc
    if message.get("type") != "auth" or not message.get("idToken"):
        raise HTTPException(status_code=401, detail="Missing auth message")
    return await verify_bearer_token(str(message["idToken"]))


async def _send_history(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    limit: int = _DEFAULT_HISTORY_LIMIT,
) -> None:
    response = await conn.request(
        "chat.history",
        {"sessionKey": session_key, "limit": limit, "maxChars": 200000},
        timeout=20,
    )
    await websocket.send_json(
        {
            "type": "chat.history",
            "payload": sanitize_frame(
                response.get("payload") or response,
                media_session_key=session_key,
            ),
        }
    )


async def _bridge_loop(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    normalizer: Normalizer,
) -> None:
    from_browser = asyncio.create_task(
        _browser_to_openclaw(websocket, conn, session_key, normalizer)
    )
    from_openclaw = asyncio.create_task(
        _openclaw_to_browser(websocket, conn, session_key, normalizer)
    )
    done, pending = await asyncio.wait(
        {from_browser, from_openclaw},
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    for task in done:
        try:
            task.result()
        except WebSocketDisconnect:
            return


async def _browser_to_openclaw(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    normalizer: Normalizer,
) -> None:
    loop = asyncio.get_running_loop()
    while True:
        try:
            message = await websocket.receive_json()
        except (ValueError, TypeError):
            await websocket.send_json(
                {"type": "bridge.warning", "message": "Invalid JSON message"}
            )
            continue
        if not isinstance(message, dict):
            await websocket.send_json(
                {"type": "bridge.warning", "message": "Invalid message"}
            )
            continue
        message_type = message.get("type")
        if message_type == "ping":
            await websocket.send_json({"type": "pong"})
            continue
        if message_type == "chat.history":
            await _handle_history(websocket, conn, session_key, message)
            continue
        if message_type == "chat.abort":
            await _handle_abort(websocket, conn, session_key, normalizer, loop.time())
            continue
        if message_type != "chat.send":
            await websocket.send_json(
                {"type": "bridge.warning", "message": f"Unknown message: {message_type}"}
            )
            continue
        await _handle_send(websocket, conn, session_key, normalizer, message, loop)


async def _handle_history(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    message: Dict[str, Any],
) -> None:
    try:
        limit = _history_limit(message.get("limit"))
    except HTTPException as exc:
        await websocket.send_json({"type": "bridge.warning", "message": exc.detail})
        return
    try:
        await _send_history(websocket, conn, session_key, limit=limit)
    except OpenClawError as exc:
        # Non-fatal: a history fetch failure must not tear down the session.
        await websocket.send_json(
            {"type": "bridge.error", "message": str(exc), "fatal": False}
        )


async def _handle_abort(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    normalizer: Normalizer,
    now: float,
) -> None:
    try:
        response = await conn.request(
            "chat.abort", {"sessionKey": session_key}, timeout=10
        )
    except OpenClawError as exc:
        await websocket.send_json(
            {"type": "bridge.error", "message": str(exc), "fatal": False}
        )
        return
    for event in normalizer.end_turn(now, status="aborted"):
        await websocket.send_json(event)
    await websocket.send_json(
        {"type": "chat.abort.result", "payload": _safe_sanitize(response, session_key)}
    )


async def _handle_send(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    normalizer: Normalizer,
    message: Dict[str, Any],
    loop: asyncio.AbstractEventLoop,
) -> None:
    params: Dict[str, Any] = {
        "sessionKey": session_key,
        "message": str(message.get("message") or ""),
        "idempotencyKey": idempotency_key(
            session_key, message.get("clientMessageId")
        ),
    }
    attachments = message.get("attachments")
    if isinstance(attachments, list) and attachments:
        params["attachments"] = attachments
    normalizer.begin_turn(loop.time())
    try:
        response = await _send_chat_message(conn, session_key, params)
    except OpenClawError as exc:
        # Contain a per-message upstream failure: report it and finalize the
        # turn so the UI is not stuck "thinking", but keep the socket open so
        # the optimistic message is preserved and the user can retry.
        for event in normalizer.fail_turn(loop.time(), str(exc)):
            await websocket.send_json(event)
        await websocket.send_json(
            {"type": "bridge.error", "message": str(exc), "fatal": False}
        )
        return
    normalizer.note_run_started(_extract_run_id(response), loop.time())
    await websocket.send_json(
        {"type": "chat.send.result", "payload": _safe_sanitize(response, session_key)}
    )


async def _send_chat_message(
    conn: OpenClawConnection,
    session_key: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    # verboseLevel=full must be applied so the gateway keeps tool results and
    # mediaUrls; apply it once per connection (the setting is sticky server-side
    # and a per-message patch would add a failure point to every send).
    if not getattr(conn, "verbose_full_applied", False):
        await conn.request(
            "sessions.patch",
            {"key": session_key, "verboseLevel": "full"},
            timeout=10,
        )
        try:
            conn.verbose_full_applied = True
        except AttributeError:  # pragma: no cover - test doubles may be frozen
            pass
    return await conn.request("chat.send", params, timeout=20)


def _history_limit(value: Any) -> int:
    if value in (None, ""):
        return _DEFAULT_HISTORY_LIMIT
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Invalid chat.history limit",
        ) from exc
    if limit < 1:
        raise HTTPException(status_code=400, detail="Invalid chat.history limit")
    return min(limit, _MAX_HISTORY_LIMIT)


def _frontend_static_dir() -> Path | None:
    static_dir = os.getenv("OPENCLAW_WEBCHAT_STATIC_DIR")
    if not static_dir:
        return None
    path = Path(static_dir).resolve()
    if not path.is_dir():
        return None
    index = path / "index.html"
    if not index.is_file():
        return None
    return path


async def _openclaw_to_browser(
    websocket: WebSocket,
    conn: OpenClawConnection,
    session_key: str,
    normalizer: Normalizer,
) -> None:
    loop = asyncio.get_running_loop()
    # Keep a single pending get() across iterations: asyncio.wait_for would drop
    # a frame dequeued exactly when the timeout fires, silently swallowing a
    # delta. asyncio.wait leaves the get() pending on timeout so we never lose it.
    get_task = asyncio.ensure_future(conn.events.get())
    try:
        while True:
            timeout = normalizer.next_timeout(loop.time())
            done, _ = await asyncio.wait({get_task}, timeout=timeout)
            now = loop.time()
            if get_task in done:
                frame = get_task.result()
                get_task = asyncio.ensure_future(conn.events.get())
                if isinstance(frame, dict) and frame.get("type") == "bridge.error":
                    await _safe_send_error(
                        websocket,
                        str(frame.get("message") or "OpenClaw connection error"),
                        code=1011,
                    )
                    return
                events = normalizer.feed(frame, now)
            else:
                events = normalizer.tick(now)
            for event in events:
                await websocket.send_json(event)
    finally:
        if not get_task.done():
            get_task.cancel()


_STATIC_DIR = _frontend_static_dir()


if _STATIC_DIR is not None:

    @app.get("/")
    async def frontend_index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    @app.get("/{path:path}")
    async def frontend_spa(path: str) -> FileResponse:
        if path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404, detail="Not found")
        target = (_STATIC_DIR / path).resolve()
        if target.is_file() and target.is_relative_to(_STATIC_DIR):
            return FileResponse(target)
        return FileResponse(_STATIC_DIR / "index.html")
