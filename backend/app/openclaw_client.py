import asyncio
import base64
import hashlib
import json
import time
import uuid
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

DEFAULT_SCOPES = [
    "operator.read",
    "operator.write",
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
]


class OpenClawError(RuntimeError):
    pass


def sign_challenge(
    device_identity: Dict[str, Any],
    nonce: str,
    ts: int,
    token: str,
) -> Dict[str, Any]:
    parts = [
        "v2",
        device_identity["id"],
        "openclaw-webchat",
        "web",
        "operator",
        ",".join(DEFAULT_SCOPES),
        str(ts),
        token,
        nonce,
    ]
    payload = "|".join(parts)
    private_key = serialization.load_pem_private_key(
        device_identity["privateKey"].encode(),
        password=None,
        backend=default_backend(),
    )
    signature = private_key.sign(payload.encode())
    return {
        "id": device_identity["id"],
        "publicKey": device_identity["publicKey"],
        "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
        "signedAt": ts,
        "nonce": nonce,
    }


def normalize_ws_url(url: str) -> str:
    if "://" not in url:
        return f"ws://{url}"
    parsed = urlparse(url)
    if parsed.scheme in ("ws", "wss"):
        return url
    if parsed.scheme == "http":
        return "ws://" + url[len("http://") :]
    if parsed.scheme == "https":
        return "wss://" + url[len("https://") :]
    raise OpenClawError(f"Unsupported OpenClaw Gateway URL scheme: {parsed.scheme}")


class OpenClawConnection:
    def __init__(self, ws):
        self.ws = ws
        self.events: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        self._pending: Dict[str, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._closed = asyncio.Event()

    @classmethod
    async def connect(
        cls,
        gateway_url: str,
        token: str,
        device_identity: Dict[str, Any],
    ) -> "OpenClawConnection":
        if websockets is None:
            raise OpenClawError("Python package 'websockets' is required")
        try:
            ws = await websockets.connect(
                normalize_ws_url(gateway_url),
                ping_interval=20,
            )
        except Exception as exc:
            raise OpenClawError(
                f"OpenClaw Gateway connection failed: {type(exc).__name__}"
            ) from exc
        try:
            first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if (
                first.get("type") != "event"
                or first.get("event") != "connect.challenge"
            ):
                raise OpenClawError("OpenClaw did not send connect.challenge")
            challenge = first.get("payload") or {}
            signed_device = sign_challenge(
                device_identity,
                challenge.get("nonce", ""),
                int(challenge.get("ts") or time.time() * 1000),
                token,
            )
            req_id = str(uuid.uuid4())
            await ws.send(
                json.dumps(
                    {
                        "type": "req",
                        "id": req_id,
                        "method": "connect",
                        "params": {
                            "minProtocol": 3,
                            "maxProtocol": 4,
                            "client": {
                                "id": "openclaw-webchat",
                                "version": "0.1.0",
                                "platform": "web",
                                "mode": "web",
                            },
                            "role": "operator",
                            "scopes": DEFAULT_SCOPES,
                            "auth": {"token": token},
                            "device": signed_device,
                            "locale": "fr-CA",
                            "userAgent": "openclaw-webchat-bridge/0.1.0",
                            "caps": ["agent-events", "tool-events"],
                        },
                    }
                )
            )
            response = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if response.get("ok"):
                conn = cls(ws)
                conn._reader_task = asyncio.create_task(conn._reader())
                return conn
            error = response.get("error") or {}
            raise OpenClawError(
                f"{error.get('code', 'CONNECT_FAILED')}: "
                f"{error.get('message', 'OpenClaw connect failed')}"
            )
        except OpenClawError:
            await ws.close()
            raise
        except Exception as exc:
            await ws.close()
            raise OpenClawError(
                f"OpenClaw connect handshake failed: {type(exc).__name__}"
            ) from exc

    async def _reader(self) -> None:
        close_error = OpenClawError("OpenClaw Gateway connection closed")
        notified = False
        try:
            async for raw in self.ws:
                frame = json.loads(raw)
                if frame.get("type") == "res":
                    future = self._pending.pop(str(frame.get("id")), None)
                    if future is not None and not future.done():
                        future.set_result(frame)
                    continue
                await self.events.put(frame)
        except Exception as exc:
            close_error = OpenClawError(str(exc) or type(exc).__name__)
            await self.events.put(
                {"type": "bridge.error", "message": str(close_error)}
            )
            notified = True
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(close_error)
            self._pending.clear()
            if not notified:
                await self.events.put(
                    {"type": "bridge.error", "message": str(close_error)}
                )
            self._closed.set()

    async def request(
        self,
        method: str,
        params: Dict[str, Any],
        timeout: float = 30,
    ) -> Dict[str, Any]:
        req_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[req_id] = future
        try:
            await self.ws.send(
                json.dumps(
                    {
                        "type": "req",
                        "id": req_id,
                        "method": method,
                        "params": params,
                    }
                )
            )
            try:
                response = await asyncio.wait_for(future, timeout=timeout)
            except asyncio.TimeoutError as exc:
                raise OpenClawError(f"{method} timed out") from exc
        finally:
            self._pending.pop(req_id, None)
        if not response.get("ok", True):
            error = response.get("error") or {}
            raise OpenClawError(
                f"{error.get('code', 'REQUEST_FAILED')}: "
                f"{error.get('message', method + ' failed')}"
            )
        return response

    async def close(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
        await self.ws.close()


def idempotency_key(session_key: str, client_message_id: str | None) -> str:
    if not client_message_id:
        return f"webchat-{uuid.uuid4()}"
    digest = hashlib.sha256(f"{session_key}|{client_message_id}".encode()).hexdigest()
    return f"webchat-{digest}"
