from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from flask import Flask, Response, jsonify, request


app = Flask(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
EVENTS_PATH = DATA_DIR / "eventbrite_events.jsonl"
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "").strip()
EVENTBRITE_TOKEN = os.environ.get("EVENTBRITE_OAUTH_TOKEN", "").strip()
MAX_RETURNED_EVENTS = int(os.environ.get("MAX_RETURNED_EVENTS", "100"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_authorized(path_secret: str | None = None) -> bool:
    if not WEBHOOK_SECRET:
        return True
    candidates = {
        path_secret,
        request.args.get("secret"),
        request.headers.get("X-Webhook-Secret"),
    }
    return WEBHOOK_SECRET in candidates


def _json_response(payload: Any, status: int = 200) -> Response:
    return Response(
        json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n",
        status=status,
        mimetype="application/json",
    )


def _safe_eventbrite_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.netloc == "www.eventbriteapi.com"


def _fetch_eventbrite(url: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    if not EVENTBRITE_TOKEN:
        return {"_skipped": "EVENTBRITE_OAUTH_TOKEN is not set"}
    if not _safe_eventbrite_url(url):
        return {"_error": f"Refusing to fetch non-Eventbrite API URL: {url}"}

    try:
        response = requests.get(
            url,
            headers={
                "Authorization": f"Bearer {EVENTBRITE_TOKEN}",
                "Accept": "application/json",
            },
            params=params,
            timeout=15,
        )
    except requests.RequestException as exc:
        return {"_error": str(exc)}

    try:
        body = response.json()
    except ValueError:
        body = {"raw_text": response.text[:2000]}

    if response.status_code >= 400:
        return {"_error": f"HTTP {response.status_code}", "body": body}
    return body


def _parse_object(api_url: str | None) -> tuple[str | None, str | None]:
    if not api_url:
        return None, None
    match = re.search(r"/v3/([^/]+)/([^/]+)/?", api_url)
    if not match:
        return None, None
    return match.group(1).rstrip("s"), match.group(2)


def _money_display(value: Any) -> str | None:
    if isinstance(value, dict):
        return value.get("display") or value.get("major_value")
    return None


def _profile_name(profile: dict[str, Any]) -> str | None:
    return (
        profile.get("name")
        or " ".join(
            part
            for part in [profile.get("first_name"), profile.get("last_name")]
            if part
        ).strip()
        or None
    )


def _answer_summary(answers: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    cleaned = []
    for answer in answers or []:
        question = answer.get("question")
        value = answer.get("answer")
        if question and value:
            cleaned.append({"question": str(question), "answer": str(value)})
    return cleaned


def _attendee_summary(attendee: dict[str, Any]) -> dict[str, Any]:
    profile = attendee.get("profile") or {}
    return {
        "name": _profile_name(profile) or attendee.get("name"),
        "email": profile.get("email") or attendee.get("email"),
        "checked_in": attendee.get("checked_in"),
        "status": attendee.get("status"),
        "ticket": attendee.get("ticket_class_name"),
        "event_id": attendee.get("event_id"),
        "order_id": attendee.get("order_id"),
        "attendee_id": attendee.get("id"),
        "answers": _answer_summary(attendee.get("answers")),
    }


def _event_summary(event: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(event, dict):
        return None
    name = event.get("name")
    start = event.get("start")
    return {
        "name": name.get("text") if isinstance(name, dict) else name,
        "start": start.get("local") if isinstance(start, dict) else start,
        "event_id": event.get("id"),
        "url": event.get("url"),
    }


def _load_eventbrite_details(api_url: str | None) -> dict[str, Any]:
    if not api_url:
        return {}

    details: dict[str, Any] = {"primary": _fetch_eventbrite(api_url)}
    object_type, object_id = _parse_object(api_url)

    if object_type == "order" and object_id:
        attendees_url = f"https://www.eventbriteapi.com/v3/orders/{object_id}/attendees/"
        details["attendees"] = _fetch_eventbrite(attendees_url)

    primary = details.get("primary")
    if isinstance(primary, dict):
        event_id = primary.get("event_id")
        if event_id:
            event_url = f"https://www.eventbriteapi.com/v3/events/{event_id}/"
            details["event"] = _fetch_eventbrite(event_url)

    return details


def _build_summary(payload: dict[str, Any], details: dict[str, Any]) -> dict[str, Any]:
    api_url = payload.get("api_url")
    object_type, object_id = _parse_object(api_url)
    config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
    primary = details.get("primary") if isinstance(details.get("primary"), dict) else {}
    event = details.get("event") if isinstance(details.get("event"), dict) else None

    summary: dict[str, Any] = {
        "received_at": _now_iso(),
        "object_type": object_type,
        "object_id": object_id,
        "api_url": api_url,
        "endpoint_url": config.get("endpoint_url"),
        "action": payload.get("action") or config.get("action") or "not supplied by Eventbrite",
        "event": _event_summary(event),
    }

    if object_type == "order":
        profile = primary.get("profile") or {}
        attendees_body = details.get("attendees") if isinstance(details.get("attendees"), dict) else {}
        attendees = attendees_body.get("attendees") if isinstance(attendees_body, dict) else None
        attendees = attendees if isinstance(attendees, list) else primary.get("attendees")
        costs = primary.get("costs") if isinstance(primary.get("costs"), dict) else {}

        summary["order"] = {
            "order_id": primary.get("id") or object_id,
            "buyer_name": _profile_name(profile) or primary.get("name"),
            "buyer_email": profile.get("email") or primary.get("email"),
            "created": primary.get("created"),
            "changed": primary.get("changed"),
            "status": primary.get("status"),
            "gross": _money_display(costs.get("gross")),
            "event_id": primary.get("event_id"),
        }
        if isinstance(attendees, list):
            summary["attendees"] = [_attendee_summary(attendee) for attendee in attendees]

    elif object_type == "attendee":
        summary["attendee"] = _attendee_summary(primary)

    elif object_type == "event":
        summary["event"] = _event_summary(primary)

    elif object_type:
        summary[object_type] = {
            "id": primary.get("id") or object_id,
            "name": primary.get("name"),
            "changed": primary.get("changed"),
        }

    errors = {
        name: value
        for name, value in details.items()
        if isinstance(value, dict) and ("_error" in value or "_skipped" in value)
    }
    if errors:
        summary["detail_fetch"] = errors

    return summary


def _save_event(record: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with EVENTS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, default=str) + "\n")


def _read_events() -> list[dict[str, Any]]:
    if not EVENTS_PATH.exists():
        return []
    events: list[dict[str, Any]] = []
    with EVENTS_PATH.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events[-MAX_RETURNED_EVENTS:]


@app.get("/")
def home() -> Response:
    return _json_response(
        {
            "ok": True,
            "service": "QBK Eventbrite webhook receiver",
            "webhook_path": "/eventbrite/webhook/<secret>",
            "readable_events_path": "/eventbrite/events/<secret>",
            "token_fetch_enabled": bool(EVENTBRITE_TOKEN),
            "stored_events": len(_read_events()),
        }
    )


@app.get("/health")
def health() -> Response:
    return _json_response({"ok": True})


@app.post("/eventbrite/webhook")
@app.post("/eventbrite/webhook/<path_secret>")
def eventbrite_webhook(path_secret: str | None = None) -> Response:
    if not _is_authorized(path_secret):
        return _json_response({"ok": False, "error": "not found"}, status=404)

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_response({"ok": False, "error": "Expected a JSON object"}, status=400)

    details = _load_eventbrite_details(payload.get("api_url"))
    summary = _build_summary(payload, details)
    record = {
        "received_at": summary["received_at"],
        "summary": summary,
        "payload": payload,
        "details": details,
        "headers": {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"authorization", "cookie"}
        },
    }
    _save_event(record)
    app.logger.info("EVENTBRITE_WEBHOOK_READABLE %s", json.dumps(summary, sort_keys=True))
    return _json_response({"ok": True, "summary": summary})


@app.get("/eventbrite/events")
@app.get("/eventbrite/events/<path_secret>")
def eventbrite_events(path_secret: str | None = None) -> Response:
    if not _is_authorized(path_secret):
        return _json_response({"ok": False, "error": "not found"}, status=404)
    records = _read_events()
    return _json_response(
        {
            "ok": True,
            "count": len(records),
            "events": [record.get("summary", record) for record in reversed(records)],
        }
    )


@app.get("/eventbrite/raw")
@app.get("/eventbrite/raw/<path_secret>")
def eventbrite_raw(path_secret: str | None = None) -> Response:
    if not _is_authorized(path_secret):
        return _json_response({"ok": False, "error": "not found"}, status=404)
    records = _read_events()
    return _json_response({"ok": True, "count": len(records), "events": list(reversed(records))})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
