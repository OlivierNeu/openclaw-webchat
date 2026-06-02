"""Regression tests for the streaming normalizer.

Each test replays real OpenClaw frame shapes (tests/fixtures/openclaw_frames.json)
through the normalizer with an INJECTED clock and asserts the stable events a
correct bridge must emit. Every scenario guards a regression the integration has
hit before (empty finals, duplicate finals, compaction, private acks, ...).

The normalizer is a pure transducer, so no event loop, websocket, gateway or
firebase is needed -- only the sanitizer (stdlib-only). These tests run with
nothing but pytest installed.
"""

import json
from pathlib import Path

import pytest

from app.normalizer import (
    BASE_RECV_TIMEOUT,
    EMPTY_FINAL_GRACE,
    LIFECYCLE_END_GRACE,
    PRIVATE_ACK_GRACE,
    Normalizer,
)

_FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "openclaw_frames.json").read_text()
)
SESSION_KEY = _FIXTURES["session_key"]
OWN_RUN = _FIXTURES["run_id"]


@pytest.fixture(autouse=True)
def _media_secret(monkeypatch):
    # Needed by the sanitizer to mint signed links for MEDIA: directives.
    monkeypatch.setenv("OPENCLAW_MEDIA_LINK_SECRET", "test-media-secret")
    monkeypatch.delenv("OPENCLAW_WEBCHAT_PUBLIC_BASE_URL", raising=False)


def _media_resolver(filename):
    return f"https://media.test/{filename}"


def _new_normalizer():
    return Normalizer(SESSION_KEY, _media_resolver)


def _frames(scenario):
    return _FIXTURES["scenarios"][scenario]["frames"]


class Clock:
    def __init__(self):
        self.now = 1000.0

    def tick(self, seconds=0.01):
        self.now += seconds
        return self.now


def drive(scenario, *, seed_run=OWN_RUN, advance_to_finalize=False):
    """Replay a scenario; return (events, normalizer, clock)."""
    normalizer = _new_normalizer()
    clock = Clock()
    events = []
    normalizer.begin_turn(clock.now)
    if seed_run:
        normalizer.note_run_started(seed_run, clock.now)
    for frame in _frames(scenario):
        events.extend(normalizer.feed(frame, clock.tick()))
    if advance_to_finalize and not normalizer.finalized:
        # Jump past every armed grace so any pending turn finalizes.
        clock.tick(BASE_RECV_TIMEOUT + 1)
        events.extend(normalizer.tick(clock.now))
    return events, normalizer, clock


def visible_text(events):
    """Reconstruct what the reference frontend would render, including the
    compaction reset signalled by run.status=compacting."""
    text = ""
    for event in events:
        kind = event["type"]
        if kind == "message.delta":
            text += event["text"]
        elif kind in ("message.snapshot", "message.final"):
            text = event["text"]
        elif kind == "run.status" and event.get("status") == "compacting":
            text = ""
    return text


def final_text(events):
    finals = [e for e in events if e["type"] == "message.final"]
    return finals[-1]["text"] if finals else None


def statuses(events):
    return [e["status"] for e in events if e["type"] == "run.status"]


def media_items(events):
    items = []
    for event in events:
        if event["type"] == "media":
            items.extend(event["items"])
    return items


# --- core text scenarios -----------------------------------------------------


def test_chat_final_content_list_parts():
    events, _, _ = drive("chat-final-content")
    assert final_text(events) == "Bonjour !"
    assert visible_text(events) == "Bonjour !"


def test_chat_final_content_string():
    events, _, _ = drive("chat-final-content-string")
    assert final_text(events) == "Réponse en texte simple."


def test_empty_final_then_content_is_not_lost():
    events, normalizer, _ = drive("chat-final-empty-then-content")
    assert normalizer.finalized
    assert final_text(events) == "Réponse arrivée après final vide."
    # The sessionless 'health' broadcast must never reach the browser.
    assert all(e["type"] != "openclaw.frame" or e["frame"].get("event") != "health"
               for e in events)


def test_duplicate_final_is_deduped():
    events, _, _ = drive("duplicate-final")
    deltas = [e["text"] for e in events if e["type"] == "message.delta"]
    assert deltas == ["Hello ", "Hello ", "world!"]  # the exact re-broadcast dropped
    assert final_text(events) == "Hello Hello world!"


def test_chat_deltatext_preserves_spaces():
    events, _, _ = drive("chat-deltatext-spaces")
    assert final_text(events) == "Voici l'image générée !"
    assert visible_text(events) == "Voici l'image générée !"


def test_agent_assistant_delta_legacy_accumulates():
    events, normalizer, _ = drive(
        "agent-assistant-delta-legacy", advance_to_finalize=True
    )
    assert normalizer.finalized
    assert final_text(events) == "Hello world"


def test_duplicate_empty_final_finalizes_gracefully():
    events, normalizer, _ = drive("duplicate-empty-final", advance_to_finalize=True)
    # No content was ever delivered, but the turn must still close cleanly.
    assert normalizer.finalized
    assert final_text(events) == ""
    # The duplicate empty final emitted no normalized message event.
    assert not [e for e in events if e["type"] in ("message.delta", "message.snapshot")]


# --- multi-run / lifecycle ---------------------------------------------------


def test_lifecycle_end_then_followon_run():
    events, normalizer, _ = drive("lifecycle-end-then-followon-run")
    assert normalizer.finalized
    assert final_text(events) == "Réponse de suivi."
    assert "working" in statuses(events) and "running" in statuses(events)


def test_compaction_abandoned_resets_buffer():
    events, normalizer, _ = drive(
        "compaction-abandoned-replay", advance_to_finalize=True
    )
    assert "compacting" in statuses(events)
    # part1 was invalidated by the abandoned marker; only part2 survives.
    assert final_text(events) == "part2"
    assert visible_text(events) == "part2"


def test_normal_end_working_replayinvalid_does_not_reset():
    events, normalizer, _ = drive(
        "normal-end-working-replayinvalid", advance_to_finalize=True
    )
    assert "compacting" not in statuses(events)
    assert final_text(events) == "complete answer"


# --- private acks ------------------------------------------------------------


def test_private_ack_then_visible_message_wins():
    events, normalizer, _ = drive("private-ack-then-visible")
    assert normalizer.finalized
    assert final_text(events) == "L'identifiant visible."
    # The ack was never emitted as a message.
    assert "Envoyé." not in visible_text(events)


def test_private_ack_only_finalizes_gracefully():
    # No follow-on ever arrives; after the grace the turn must finalize, not hang.
    normalizer = _new_normalizer()
    clock = Clock()
    events = []
    normalizer.begin_turn(clock.now)
    normalizer.note_run_started(OWN_RUN, clock.now)
    for frame in _frames("private-ack-only"):
        events.extend(normalizer.feed(frame, clock.tick()))
    assert not normalizer.finalized  # still waiting for the visible message
    # Nearest deadline is the private-ack grace.
    assert normalizer.next_timeout(clock.now) <= PRIVATE_ACK_GRACE
    clock.tick(PRIVATE_ACK_GRACE + 1)
    events.extend(normalizer.tick(clock.now))
    assert normalizer.finalized
    assert final_text(events) == "Envoyé."  # best-effort fallback, never blank hang


# --- tool message delivery ---------------------------------------------------


def test_message_tool_visible_beats_private_ack():
    events, _, _ = drive("tool-message-visible")
    assert final_text(events) == "Réponse visible complète."
    assert any(e["type"] == "tool.status" and e["name"] == "message" for e in events)


def test_message_tool_external_target_is_ignored():
    events, _, _ = drive("tool-message-external-target-ignored")
    assert final_text(events) == "Réponse réelle."


# --- media -------------------------------------------------------------------


def test_mediaurls_list_is_filtered_and_resolved():
    events, _, _ = drive("mediaurls-list", advance_to_finalize=True)
    items = media_items(events)
    assert [i["filename"] for i in items] == ["a.pdf", "c.pdf"]
    assert all(i["url"].startswith("https://media.test/") for i in items)


def test_media_directive_converted_no_local_path_leaks():
    events, _, _ = drive("media-directive", advance_to_finalize=True)
    text = final_text(events)
    assert "/home/node/.openclaw" not in text
    assert "[r.pdf](" in text


# --- upstream error ----------------------------------------------------------


def test_lifecycle_error_finalizes_as_error_with_partial():
    events, normalizer, _ = drive("lifecycle-error")
    assert normalizer.finalized
    assert "error" in statuses(events)
    assert final_text(events) == "moitié"  # partial content preserved
    final = [e for e in events if e["type"] == "message.final"][-1]
    assert "Context overflow" in final.get("error", "")


# --- isolation ---------------------------------------------------------------


def test_foreign_session_frame_is_dropped():
    events, _, _ = drive("isolation-foreign-session")
    assert events == []


def test_same_session_foreign_run_is_dropped():
    events, _, _ = drive("isolation-same-session-foreign-run")
    assert events == []  # sessionKey match alone is not enough


def test_sessionless_frame_is_dropped():
    events, _, _ = drive("isolation-sessionless")
    assert events == []


def test_passthrough_openclaw_frame_emitted_for_own_frames():
    events, _, _ = drive("chat-final-content")
    passthroughs = [e for e in events if e["type"] == "openclaw.frame"]
    assert passthroughs, "deprecated openclaw.frame passthrough must still be emitted"


# --- timing model ------------------------------------------------------------


def test_next_timeout_is_none_when_idle():
    normalizer = _new_normalizer()
    assert normalizer.next_timeout(1000.0) is None  # no turn -> wait forever


def test_recv_budget_armed_during_active_turn():
    normalizer = _new_normalizer()
    normalizer.begin_turn(1000.0)
    timeout = normalizer.next_timeout(1000.0)
    assert timeout is not None and timeout <= BASE_RECV_TIMEOUT
