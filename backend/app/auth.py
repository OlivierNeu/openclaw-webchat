import os
from typing import Optional

import firebase_admin
from fastapi import HTTPException, WebSocket
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials

from .models import AuthenticatedUser

_firebase_initialized = False


def _allowed_domains() -> set[str]:
    raw = os.getenv("ALLOWED_EMAIL_DOMAINS", "")
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _allowed_emails() -> set[str]:
    raw = os.getenv("ALLOWED_EMAILS", "")
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _assert_allowed(email: str) -> None:
    normalized = email.lower().strip()
    emails = _allowed_emails()
    domains = _allowed_domains()
    if emails and normalized in emails:
        return
    domain = normalized.rsplit("@", 1)[-1] if "@" in normalized else ""
    if domains and domain in domains:
        return
    if not emails and not domains:
        return
    raise HTTPException(status_code=403, detail="Email is not allowed")


def _init_firebase() -> None:
    global _firebase_initialized
    if _firebase_initialized:
        return
    if firebase_admin._apps:
        _firebase_initialized = True
        return
    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    project_id = os.getenv("FIREBASE_PROJECT_ID")
    if credentials_path:
        cred = credentials.Certificate(credentials_path)
        firebase_admin.initialize_app(cred, {"projectId": project_id})
    else:
        firebase_admin.initialize_app(options={"projectId": project_id})
    _firebase_initialized = True


def _dev_user(token: str) -> Optional[AuthenticatedUser]:
    if os.getenv("ALLOW_DEV_AUTH", "").lower() not in ("1", "true", "yes"):
        return None
    if not token.startswith("dev:"):
        return None
    email = token[4:].strip().lower()
    if not email:
        return None
    _assert_allowed(email)
    return AuthenticatedUser(email=email, name=email, uid=f"dev:{email}")


async def verify_bearer_token(token: str) -> AuthenticatedUser:
    dev = _dev_user(token)
    if dev is not None:
        return dev
    _init_firebase()
    try:
        decoded = firebase_auth.verify_id_token(token, check_revoked=True)
    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail="Invalid Firebase token",
        ) from exc
    email = str(decoded.get("email", "")).lower().strip()
    if not email:
        raise HTTPException(status_code=401, detail="Firebase token has no email")
    if decoded.get("email_verified") is not True:
        raise HTTPException(status_code=401, detail="Firebase email is not verified")
    _assert_allowed(email)
    return AuthenticatedUser(
        email=email,
        name=str(decoded.get("name", "")),
        picture=str(decoded.get("picture", "")),
        uid=str(decoded.get("uid", "")),
    )


def token_from_authorization(header: str | None) -> str:
    if not header:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    prefix = "bearer "
    if not header.lower().startswith(prefix):
        raise HTTPException(status_code=401, detail="Expected Bearer token")
    token = header[len(prefix) :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty Bearer token")
    return token


async def verify_websocket_user(websocket: WebSocket) -> AuthenticatedUser:
    token = websocket.query_params.get("idToken")
    if not token:
        auth_header = websocket.headers.get("authorization")
        token = token_from_authorization(auth_header)
    return await verify_bearer_token(token)
