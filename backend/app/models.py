from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class InstanceConfig(BaseModel):
    url: str
    token: Optional[str] = None
    tokenEnv: Optional[str] = None
    deviceIdentity: Optional[Dict[str, Any]] = None
    deviceIdentityEnv: Optional[str] = None


class UserProfile(BaseModel):
    instance: str
    agentId: str
    canonical: str
    displayName: str
    allowedChatPrefixes: List[str] = Field(default_factory=list)


class BridgeConfig(BaseModel):
    instances: Dict[str, InstanceConfig]
    users: Dict[str, UserProfile]


class AuthenticatedUser(BaseModel):
    email: str
    name: str = ""
    picture: str = ""
    uid: str = ""


class ResolvedOpenClawTarget(BaseModel):
    email: str
    displayName: str
    instanceName: str
    agentId: str
    canonical: str
    sessionKey: str
    gatewayUrl: str
    token: str
    deviceIdentity: Dict[str, Any]

