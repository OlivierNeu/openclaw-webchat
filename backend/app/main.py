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
from .openclaw_client import OpenClawConnection, OpenClawError, idempotency_key
from .sanitizer import (
    MediaConfigurationError,
    media_signature_valid,
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
        await _send_history(websocket, conn, target.sessionKey)
        await _bridge_loop(websocket, conn, target.sessionKey)
    except HTTPException as exc:
        await websocket.send_json({"type": "bridge.error", "message": exc.detail})
        await websocket.close(code=1008)
    except (ConfigError, OpenClawError) as exc:
        await websocket.send_json({"type": "bridge.error", "message": str(exc)})
        await websocket.close(code=1011)
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
) -> None:
    from_browser = asyncio.create_task(
        _browser_to_openclaw(websocket, conn, session_key)
    )
    from_openclaw = asyncio.create_task(_openclaw_to_browser(websocket, conn, session_key))
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
) -> None:
    while True:
        message = await websocket.receive_json()
        message_type = message.get("type")
        if message_type == "ping":
            await websocket.send_json({"type": "pong"})
            continue
        if message_type == "chat.history":
            await _send_history(
                websocket,
                conn,
                session_key,
                limit=_history_limit(message.get("limit")),
            )
            continue
        if message_type == "chat.abort":
            response = await conn.request(
                "chat.abort",
                {"sessionKey": session_key},
                timeout=10,
            )
            await websocket.send_json({"type": "chat.abort.result", "payload": response})
            continue
        if message_type != "chat.send":
            await websocket.send_json(
                {"type": "bridge.warning", "message": f"Unknown message: {message_type}"}
            )
            continue
        params = {
            "sessionKey": session_key,
            "message": str(message.get("message") or ""),
            "idempotencyKey": idempotency_key(
                session_key,
                message.get("clientMessageId"),
            ),
        }
        attachments = message.get("attachments")
        if isinstance(attachments, list) and attachments:
            params["attachments"] = attachments
        response = await _send_chat_message(conn, session_key, params)
        await websocket.send_json({"type": "chat.send.result", "payload": response})


async def _send_chat_message(
    conn: OpenClawConnection,
    session_key: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    await conn.request(
        "sessions.patch",
        {"key": session_key, "verboseLevel": "full"},
        timeout=10,
    )
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
) -> None:
    while True:
        frame = await conn.events.get()
        if isinstance(frame, dict) and frame.get("type") == "bridge.error":
            await websocket.send_json(
                {
                    "type": "bridge.error",
                    "message": str(
                        frame.get("message") or "OpenClaw connection error"
                    ),
                }
            )
            await websocket.close(code=1011)
            return
        payload = frame.get("payload") if isinstance(frame, dict) else None
        frame_session_key = (
            payload.get("sessionKey") if isinstance(payload, dict) else None
        )
        if frame_session_key != session_key:
            continue
        try:
            sanitized_frame = sanitize_frame(frame, media_session_key=session_key)
        except MediaConfigurationError as exc:
            await websocket.send_json({"type": "bridge.error", "message": str(exc)})
            await websocket.close(code=1011)
            return
        await websocket.send_json({"type": "openclaw.frame", "frame": sanitized_frame})


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
