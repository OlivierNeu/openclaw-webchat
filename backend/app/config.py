import json
import os
from pathlib import Path
from typing import Dict

from .models import BridgeConfig, ResolvedOpenClawTarget, UserProfile
from .session_keys import build_session_key


class ConfigError(RuntimeError):
    pass


def _load_json_source() -> Dict:
    raw = os.getenv("OPENCLAW_WEBCHAT_CONFIG")
    if raw:
        return json.loads(raw)
    file_path = os.getenv("OPENCLAW_WEBCHAT_CONFIG_FILE")
    if file_path:
        return json.loads(Path(file_path).read_text())
    raise ConfigError(
        "OPENCLAW_WEBCHAT_CONFIG or OPENCLAW_WEBCHAT_CONFIG_FILE is required"
    )


def load_config() -> BridgeConfig:
    return BridgeConfig.model_validate(_load_json_source())


def _read_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def _resolve_secret(value: str | None, env_name: str | None) -> str:
    if value:
        return value
    if env_name:
        return _read_required_env(env_name)
    return ""


def _resolve_device_identity(value, env_name: str | None) -> Dict:
    if value:
        return value
    if not env_name:
        raise ConfigError("deviceIdentity or deviceIdentityEnv is required")
    return json.loads(_read_required_env(env_name))


def resolve_user_target(
    config: BridgeConfig,
    email: str,
    chat_id: str,
) -> ResolvedOpenClawTarget:
    normalized_email = email.lower().strip()
    profile: UserProfile | None = config.users.get(normalized_email)
    if profile is None:
        raise ConfigError(f"Email is not mapped to an OpenClaw profile: {email}")
    instance = config.instances.get(profile.instance)
    if instance is None:
        raise ConfigError(f"Unknown OpenClaw instance: {profile.instance}")
    token = _resolve_secret(instance.token, instance.tokenEnv)
    device_identity = _resolve_device_identity(
        instance.deviceIdentity,
        instance.deviceIdentityEnv,
    )
    return ResolvedOpenClawTarget(
        email=normalized_email,
        displayName=profile.displayName,
        instanceName=profile.instance,
        agentId=profile.agentId,
        canonical=profile.canonical,
        sessionKey=build_session_key(profile.agentId, profile.canonical, chat_id),
        gatewayUrl=instance.url,
        token=token,
        deviceIdentity=device_identity,
    )

