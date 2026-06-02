"""Streaming normalizer for OpenClaw Gateway frames.

The OpenClaw Gateway is an event-driven firehose: it can emit empty finals,
duplicate finals, private acknowledgements, follow-on runs, auto-compaction
replays, legacy 5.7 deltas, 5.19 message snapshots, tool deliveries and media
paths -- in any interleaving. This module absorbs all of that and exposes a
small, stable, browser-facing event vocabulary so the frontend never has to
parse raw OpenClaw frames.

Design (see docs/BRIDGE_PROTOCOL.md):

  * Pure transducer with an INJECTED clock. ``feed(frame, now)`` and
    ``tick(now)`` return lists of stable events; ``next_timeout(now)`` tells
    the receive loop how long to wait. All timing is expressed as ABSOLUTE
    deadlines stored on the instance -- never as silence-reset budgets -- so a
    private-ack grace cannot be reset by an unrelated frame, and every behaviour
    is deterministic under a mocked clock.
  * One per-run text state machine (snapshot vs delta vs ack precedence) that
    every scenario routes through, rather than independent per-event handlers.
  * Isolation gate (sessionKey + runId refinement) runs before any emission, so
    the deprecated ``openclaw.frame`` passthrough and the normalized events
    share exactly one drop decision.

The grace windows mirror the values validated in production by the Open WebUI
pipe this bridge replaces.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import PurePosixPath
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit

from .sanitizer import MediaConfigurationError, sanitize_frame, sanitize_text

# --- Stable bridge event types (browser-facing contract) ---------------------
EVENT_OPENCLAW_FRAME = "openclaw.frame"  # deprecated raw passthrough
EVENT_MESSAGE_DELTA = "message.delta"  # append `text` to the streaming reply
EVENT_MESSAGE_SNAPSHOT = "message.snapshot"  # replace the streaming reply with `text`
EVENT_MESSAGE_FINAL = "message.final"  # the turn's authoritative final `text`
EVENT_RUN_STATUS = "run.status"  # {status, runId}
EVENT_TOOL_STATUS = "tool.status"  # {name, phase, runId}
EVENT_MEDIA = "media"  # {items: [{filename, url}]}

# --- Timing (seconds), absolute deadlines, mirror the OWUI pipe ---------------
BASE_RECV_TIMEOUT = 180.0  # max gap between frames during an active turn
COMPACTION_RECV_TIMEOUT = 900.0  # widened gap budget while compaction is pending
EMPTY_FINAL_GRACE = 90.0  # wait after an empty chat:final for real content
PRIVATE_ACK_GRACE = 5.0  # wait after a private-ack final for the visible message
LIFECYCLE_END_GRACE = 10.0  # wait after lifecycle:end for a follow-on run

# Channels/providers that mean "deliver into the current chat" (vs an external
# target like Telegram). A message-tool send to one of these is the visible
# reply; anything with an explicit external target is not.
_CURRENT_CHAT_CHANNELS = {
    "chat",
    "current",
    "webchat",
    "owui",
    "openwebui",
    "direct",
}
_EXTERNAL_TARGET_KEYS = ("target", "targets", "to", "accountId", "chatId")
_VISIBLE_TEXT_KEYS = ("message", "caption", "text", "body", "content", "markdown")

# A private acknowledgement is a short "sent." style confirmation OpenClaw emits
# as its own final text while the user-visible reply is delivered separately. It
# must never be persisted as the assistant answer.
import re

_PRIVATE_ACK_RE = re.compile(
    r"^\s*(?:envoy[ée]+|message\s+envoy[ée]+|r[ée]ponse\s+envoy[ée]+|done|ok|fait)"
    r"(?:\s+dans\s+le\s+(?:canal|webchat)[^.\n]*)?"
    r"[\s.!…]*$",
    re.IGNORECASE,
)


def _text_from_content(content: Any) -> str:
    """Extract human-visible text from a string or a list of content parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(p for p in parts if p)
    return ""


def _text_from_message(message: Any) -> str:
    """Extract visible text from a chat `message` snapshot (content or text)."""
    if not isinstance(message, dict):
        return ""
    text = _text_from_content(message.get("content"))
    if text:
        return text
    return _text_from_content(message.get("text"))


def _is_outbound_media_path(path: Any) -> bool:
    """True for a safe OpenClaw outbound media path (no scheme/traversal)."""
    if not isinstance(path, str) or not path:
        return False
    if not path.startswith("/"):
        return False
    if "/media/outbound/" not in path:
        return False
    if ".." in path:
        return False
    parts = urlsplit(path)
    if parts.scheme or parts.netloc or parts.query:
        return False
    return True


def _is_private_ack(text: str) -> bool:
    return bool(text) and bool(_PRIVATE_ACK_RE.match(text.strip()))


def _content_fingerprint(message: Any) -> str:
    text = _text_from_message(message)
    if not text:
        return ""
    return hashlib.sha256(text.encode()).hexdigest()


class Normalizer:
    """Per-session transducer from raw OpenClaw frames to stable bridge events.

    A single instance is shared by the two concurrent bridge tasks: the
    browser->gateway task calls :meth:`begin_turn` / :meth:`note_run_started`
    when it sends ``chat.send`` and receives the ack, and the gateway->browser
    task calls :meth:`feed` / :meth:`tick`. asyncio's single-threaded scheduling
    makes the shared mutable state safe without locks.
    """

    def __init__(
        self,
        session_key: str,
        media_resolver: Optional[Callable[[str], Optional[str]]] = None,
    ) -> None:
        self.session_key = session_key
        self._media_resolver = media_resolver
        # Session-level run tracking.
        self.own_run_ids: set[str] = set()
        self.turn_active = False
        self.finalized = True  # no turn in progress until begin_turn
        self.compaction_pending = False
        self.current_run_id: Optional[str] = None
        # Per-turn visible-text state.
        self.text = ""
        self.has_snapshot = False
        self.has_visible_tool_text = False
        self.pending_ack_text = ""
        self.media_paths: List[str] = []
        self.last_dedup_key: Optional[tuple] = None
        # Absolute deadlines: name -> monotonic time. "recv" is the silence
        # budget; the others are wall-clock graces armed from a specific event.
        self._deadlines: Dict[str, float] = {}

    # -- turn lifecycle (called from the browser->gateway task) ---------------

    def begin_turn(self, now: float) -> None:
        """Reset per-turn state when the user sends a message (before chat.send)."""
        self.turn_active = True
        self.finalized = False
        self.compaction_pending = False
        self.current_run_id = None
        self.text = ""
        self.has_snapshot = False
        self.has_visible_tool_text = False
        self.pending_ack_text = ""
        self.media_paths = []
        self.last_dedup_key = None
        # A fresh turn invalidates the previous run ids: frames arriving before
        # the new ack are admitted on sessionKey alone (own_run_ids empty), then
        # the ack seeds the new run id for foreign-run filtering.
        self.own_run_ids = set()
        self._deadlines = {}
        self._arm_recv(now)

    def note_run_started(self, run_id: Optional[str], now: float) -> None:
        """Seed own_run_ids from the chat.send ack so foreign runs are filtered."""
        if isinstance(run_id, str) and run_id:
            self.own_run_ids.add(run_id)
            if self.current_run_id is None:
                self.current_run_id = run_id
        self._arm_recv(now)

    def end_turn(
        self, now: float, status: str = "final", error: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Finalize the active turn explicitly (e.g. on chat.abort or a send error)."""
        return self._finalize(now, status=status, error=error)

    def fail_turn(self, now: float, message: str) -> List[Dict[str, Any]]:
        """Finalize the active turn as failed after a per-message upstream error."""
        return self._finalize(now, status="error", error=message)

    # -- receive-loop timing --------------------------------------------------

    def next_timeout(self, now: float) -> Optional[float]:
        """Seconds until the nearest deadline, or None when idle (wait forever)."""
        if not self._deadlines:
            return None
        return max(0.0, min(self._deadlines.values()) - now)

    def tick(self, now: float) -> List[Dict[str, Any]]:
        """Resolve expired deadlines. Guarantees an armed wait always finalizes."""
        if self.finalized:
            self._deadlines = {}
            return []
        expired = {name for name, dl in self._deadlines.items() if dl <= now}
        if not expired:
            return []
        events: List[Dict[str, Any]] = []
        if "private_ack" in expired:
            # Grace elapsed with no visible follow-on. The chat.history fallback
            # is deferred; degrade gracefully to best-effort content (never hang).
            self._clear_wait("private_ack")
            if not self.text and self.pending_ack_text:
                self.text = self.pending_ack_text
            events += self._finalize(now)
        elif "empty_final" in expired or "lifecycle_end" in expired or "recv" in expired:
            events += self._finalize(now)
        return events

    # -- main transducer ------------------------------------------------------

    def feed(self, frame: Any, now: float) -> List[Dict[str, Any]]:
        """Transduce one raw gateway frame into stable bridge events."""
        if not isinstance(frame, dict):
            return []
        if frame.get("type") == "res":
            # Request/response frames are matched by OpenClawConnection.request();
            # the ack runId is seeded via note_run_started, not forwarded here.
            return []
        event_type = frame.get("event")
        if event_type not in ("agent", "chat"):
            # Anything that is not a session content stream is unattributable and
            # is never forwarded to the browser (isolation requirement).
            return []
        payload = frame.get("payload")
        if not isinstance(payload, dict):
            return []

        # --- isolation gate (one decision for passthrough + normalized) -------
        if payload.get("sessionKey") != self.session_key:
            return []  # foreign session OR sessionless -> drop
        frame_run_id = payload.get("runId")
        if (
            isinstance(frame_run_id, str)
            and frame_run_id
            and self.own_run_ids
            and frame_run_id not in self.own_run_ids
        ):
            # Same session, different run. Admit it only while a lifecycle-end or
            # compaction grace is open (a legitimate follow-on / replay run);
            # otherwise it is a background run and must not become the answer.
            if "lifecycle_end" in self._deadlines or self.compaction_pending:
                self.own_run_ids.add(frame_run_id)
            else:
                return []
        if isinstance(frame_run_id, str) and frame_run_id:
            self.current_run_id = frame_run_id

        # Own frame: refresh the silence budget and emit the deprecated
        # passthrough first, then the normalized interpretation.
        self._arm_recv(now)
        events: List[Dict[str, Any]] = [
            {"type": EVENT_OPENCLAW_FRAME, "frame": self._safe_sanitize_frame(frame)}
        ]
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        if event_type == "chat":
            self._handle_chat(payload, data, now, events)
        else:
            self._handle_agent(payload, data, now, events)
        return events

    # -- chat (5.19 official path) -------------------------------------------

    def _handle_chat(
        self,
        payload: Dict[str, Any],
        data: Dict[str, Any],
        now: float,
        events: List[Dict[str, Any]],
    ) -> None:
        state = payload.get("state")
        is_final = state == "final"
        message = payload.get("message")
        delta_text = payload.get("deltaText")
        # Dedup key includes the message-content fingerprint: an exact
        # re-broadcast (same runId/seq/state/deltaText/content) is dropped, but a
        # same-runId/seq final with DIFFERENT content (private-ack -> visible) is
        # NOT, so the real answer is never swallowed.
        dedup_key = (
            "chat",
            payload.get("runId"),
            payload.get("seq"),
            state,
            delta_text,
            _content_fingerprint(message),
        )
        if dedup_key == self.last_dedup_key:
            return  # exact re-broadcast: passthrough only, no normalized dup
        self.last_dedup_key = dedup_key

        snapshot_text = _text_from_message(message)
        if snapshot_text:
            self._apply_visible(snapshot_text, True, is_final, now, events)
            return
        if isinstance(delta_text, str) and delta_text:
            self._apply_visible(delta_text, False, is_final, now, events)
            return
        # No usable text. A final with no deliverable is an empty final: wait for
        # follow-on content instead of ending the turn blank.
        if is_final and not self.finalized:
            if self._has_real_content():
                events += self._finalize(now)
            else:
                self._arm("empty_final", now + EMPTY_FINAL_GRACE)

    # -- agent (5.7 legacy + tool/lifecycle streams) --------------------------

    def _handle_agent(
        self,
        payload: Dict[str, Any],
        data: Dict[str, Any],
        now: float,
        events: List[Dict[str, Any]],
    ) -> None:
        stream = payload.get("stream")
        if stream == "assistant":
            media_urls = data.get("mediaUrls")
            if isinstance(media_urls, list):
                self._collect_media(media_urls, events)
            text = data.get("text")
            delta = data.get("delta")
            if isinstance(text, str) and text:
                # Full snapshot: replace and lock out later deltas/acks.
                self._apply_visible(text, True, False, now, events)
            elif isinstance(delta, str) and delta:
                # Legacy 5.7 incremental: append verbatim (spaces are load-bearing).
                self._apply_visible(delta, False, False, now, events)
            return
        if stream == "tool":
            self._handle_tool(payload, data, now, events)
            return
        if stream == "lifecycle":
            self._handle_lifecycle(payload, data, now, events)
            return
        if stream == "item":
            # 5.19 may expose only a message-tool item with hidden args. Recovery
            # via chat.history is deferred; record that a delivery happened so an
            # empty turn still finalizes with best-effort content.
            if data.get("kind") == "tool" and data.get("name") == "message":
                self.has_visible_tool_text = self.has_visible_tool_text or False

    def _handle_tool(
        self,
        payload: Dict[str, Any],
        data: Dict[str, Any],
        now: float,
        events: List[Dict[str, Any]],
    ) -> None:
        name = data.get("name")
        phase = data.get("phase")
        events.append(
            {
                "type": EVENT_TOOL_STATUS,
                "name": name,
                "phase": phase,
                "runId": self.current_run_id,
            }
        )
        if name == "message" and phase == "start":
            visible = self._message_tool_text(data.get("args"))
            if visible:
                self.has_visible_tool_text = True
                self._apply_visible(visible, True, False, now, events)
        result = data.get("result")
        if isinstance(result, (dict, list)):
            self._collect_media(_flatten_strings(result), events)

    def _handle_lifecycle(
        self,
        payload: Dict[str, Any],
        data: Dict[str, Any],
        now: float,
        events: List[Dict[str, Any]],
    ) -> None:
        phase = data.get("phase")
        if phase == "error":
            message = _extract_lifecycle_error(data.get("error"))
            events += self._finalize(now, status="error", error=message)
            return
        if phase == "end":
            # ONLY livenessState == "abandoned" signals an imminent compaction
            # restart. A plain replayInvalid with livenessState == "working" is a
            # normal terminal end (cache invalidated, no restart) and must NOT
            # reset buffers.
            if data.get("livenessState") == "abandoned":
                self._reset_for_compaction(now)
                events.append(
                    {
                        "type": EVENT_RUN_STATUS,
                        "status": "compacting",
                        "runId": self.current_run_id,
                    }
                )
            else:
                # Not necessarily turn-final: a follow-on run may continue. Arm a
                # short grace; if nothing follows, tick() finalizes.
                self._arm("lifecycle_end", now + LIFECYCLE_END_GRACE)
                events.append(
                    {
                        "type": EVENT_RUN_STATUS,
                        "status": "working",
                        "runId": self.current_run_id,
                    }
                )
            return
        if phase == "start":
            if self.compaction_pending:
                self.compaction_pending = False
                self._arm_recv(now)
            self._clear_wait("lifecycle_end")
            events.append(
                {
                    "type": EVENT_RUN_STATUS,
                    "status": "running",
                    "runId": self.current_run_id,
                }
            )

    # -- visible-text state machine ------------------------------------------

    def _apply_visible(
        self,
        candidate: str,
        is_snapshot: bool,
        is_final: bool,
        now: float,
        events: List[Dict[str, Any]],
    ) -> None:
        if self.finalized:
            return
        if is_snapshot and _is_private_ack(candidate):
            # A private acknowledgement must never be persisted as the answer.
            if self._has_real_content():
                # We already have the real reply; ignore the ack but still close
                # the turn if this was the terminal final.
                if is_final:
                    events += self._finalize(now)
                return
            # Hold the ack and wait briefly for the visible message.
            self.pending_ack_text = candidate
            self._arm("private_ack", now + PRIVATE_ACK_GRACE)
            return
        if is_snapshot:
            self.has_snapshot = True
            self.text = candidate
            emitted = candidate
            event_type = EVENT_MESSAGE_SNAPSHOT
        else:
            if self.has_snapshot:
                return  # an authoritative snapshot already won; ignore deltas
            self.text += candidate
            emitted = candidate
            event_type = EVENT_MESSAGE_DELTA
        self.pending_ack_text = ""
        self._clear_wait("empty_final")
        self._clear_wait("private_ack")
        events.append({"type": event_type, "text": self._safe_sanitize_text(emitted)})
        if is_final:
            events += self._finalize(now)

    # -- media ----------------------------------------------------------------

    def _collect_media(self, candidates: Any, events: List[Dict[str, Any]]) -> None:
        if not isinstance(candidates, list):
            return
        items: List[Dict[str, str]] = []
        for path in candidates:
            if not _is_outbound_media_path(path) or path in self.media_paths:
                continue
            self.media_paths.append(path)
            filename = PurePosixPath(path).name
            url = self._media_resolver(filename) if self._media_resolver else None
            item: Dict[str, str] = {"filename": filename}
            if url:
                item["url"] = url
            items.append(item)
        if items:
            events.append(
                {"type": EVENT_MEDIA, "items": items, "runId": self.current_run_id}
            )

    def _message_tool_text(self, args: Any) -> str:
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                return ""
        if not isinstance(args, dict):
            return ""
        if args.get("action") not in ("send", "thread-reply", None):
            return ""
        for key in _EXTERNAL_TARGET_KEYS:
            if args.get(key):
                return ""  # explicit external destination -> not the current reply
        for key in ("channel", "provider"):
            value = args.get(key)
            if value and str(value).lower() not in _CURRENT_CHAT_CHANNELS:
                return ""
        for key in _VISIBLE_TEXT_KEYS:
            text = _text_from_content(args.get(key))
            if text:
                return text
        return ""

    # -- finalization & deadlines --------------------------------------------

    def _finalize(
        self,
        now: float,
        status: str = "final",
        error: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        if self.finalized:
            return []
        self.finalized = True
        self.turn_active = False
        self.compaction_pending = False
        self._deadlines = {}
        text = self.text or self.pending_ack_text
        final_event: Dict[str, Any] = {
            "type": EVENT_MESSAGE_FINAL,
            "text": self._safe_sanitize_text(text),
        }
        status_event: Dict[str, Any] = {
            "type": EVENT_RUN_STATUS,
            "status": "error" if error else status,
            "runId": self.current_run_id,
        }
        if error:
            final_event["error"] = error
            status_event["message"] = error
        return [final_event, status_event]

    def _reset_for_compaction(self, now: float) -> None:
        # Everything the abandoned run produced is invalidated by the replay.
        self.compaction_pending = True
        self.text = ""
        self.has_snapshot = False
        self.has_visible_tool_text = False
        self.pending_ack_text = ""
        self.media_paths = []
        self.last_dedup_key = None
        self._deadlines.pop("empty_final", None)
        self._deadlines.pop("private_ack", None)
        self._deadlines.pop("lifecycle_end", None)
        self._arm_recv(now)

    def _arm_recv(self, now: float) -> None:
        if self.finalized:
            return
        budget = COMPACTION_RECV_TIMEOUT if self.compaction_pending else BASE_RECV_TIMEOUT
        self._deadlines["recv"] = now + budget

    def _arm(self, name: str, deadline: float) -> None:
        self._deadlines[name] = deadline

    def _clear_wait(self, name: str) -> None:
        self._deadlines.pop(name, None)

    def _has_real_content(self) -> bool:
        return bool(
            self.has_visible_tool_text
            or self.media_paths
            or (self.text and not _is_private_ack(self.text))
        )

    # -- sanitization wrappers (never leak server paths to the browser) -------

    def _safe_sanitize_text(self, text: str) -> str:
        try:
            return sanitize_text(text, media_session_key=self.session_key)
        except MediaConfigurationError:
            return text

    def _safe_sanitize_frame(self, frame: Any) -> Any:
        try:
            return sanitize_frame(frame, media_session_key=self.session_key)
        except MediaConfigurationError:
            # Cannot build signed media links; forward without the raw frame's
            # content rather than leaking a server path.
            return {"event": frame.get("event"), "payload": {"sanitized": False}}


def _flatten_strings(value: Any) -> List[str]:
    """Collect every string found anywhere inside a nested structure."""
    out: List[str] = []
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            out.extend(_flatten_strings(item))
    elif isinstance(value, list):
        for item in value:
            out.extend(_flatten_strings(item))
    return out


def _extract_lifecycle_error(error: Any) -> str:
    if isinstance(error, str) and error.strip():
        return error.strip()
    if isinstance(error, dict):
        for key in ("message", "error", "detail", "reason", "code"):
            value = error.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return "OpenClaw stopped the run"
