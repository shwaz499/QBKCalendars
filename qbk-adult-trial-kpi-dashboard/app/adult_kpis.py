from __future__ import annotations

import datetime as dt
import csv
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests

from .config import get_settings
from .daysmart import DaysmartClient
from .db import get_conn

LOCAL_TZ = ZoneInfo("America/New_York")
FREE_TRIAL_RE = re.compile(r"free trial class", re.I)
EVENTBRITE_ADULT_FREE_TRIAL_RE = re.compile(r"\bfree\s+adult\b.*\b(beach\s+)?volleyball\b", re.I)
EVENTBRITE_YOUTH_EXCLUSION_RE = re.compile(
    r"\b(youth|kid|kids|child|children|seals?|cubs?|beach\s+lions?|junior|juniors|teen|teens|tryouts?)\b",
    re.I,
)
EVENTBRITE_TOTALS_ROW_RE = re.compile(r"^totals?$", re.I)
ADMIN_LOGIN_URL = "https://apps.daysmartrecreation.com/dash/admin/index.php?Action=Auth/login"
ADMIN_LOGIN_VALIDATE_URL = (
    "https://apps.daysmartrecreation.com/dash/admin/index.php?Action=Auth/validateLogin.json&extension=json"
)
ADMIN_LOCATION_CHECKIN_REPORT_URL = (
    "https://apps.daysmartrecreation.com/dash/admin/index.php?Action=Report/locationCheckIn&company={company}"
)
ADMIN_CUSTOMER_CHECKINS_URL = (
    "https://apps.daysmartrecreation.com/dash/admin/index.php"
    "?Action=AdminCheckin/getCustomerCheckins&customerID={customer_id}&company={company}"
)
REPORT_TABLE_RE = re.compile(r'<table[^>]+id="results-table"[^>]*>.*?<tbody>(?P<tbody>.*?)</tbody>', re.S | re.I)
REPORT_ROW_RE = re.compile(r"<tr[^>]*>(?P<row>.*?)</tr>", re.S | re.I)
REPORT_CELL_RE = re.compile(r"<td[^>]*>(?P<cell>.*?)</td>", re.S | re.I)
CHECKIN_MATCH_WINDOW_HOURS = 6
PACK_PRODUCT_IDS = {86, 128, 192}
ADULT_FREE_TRIAL_TEAM_IDS = {1043, 786, 2948, 1513, 3987, 3989, 6280, 8420}
FREE_TRIAL_ROSTER_CSVS = {
    2023: Path("/Users/joshschwartz/Desktop/2023 Free Trial Class Roster.csv"),
    2024: Path("/Users/joshschwartz/Desktop/2024 Free Trial Class Roster.csv"),
    2025: Path("/Users/joshschwartz/Desktop/2025 Free Trial Class Roster.csv"),
}
CHECKIN_CACHE_TTL_SECONDS = 60 * 15
LOOKUP_CACHE_TTL_SECONDS = 60 * 60
RECENT_CHECKIN_FORCE_DAYS = 2
TARGETED_CHECKIN_MAX_CUSTOMERS = 300
TARGETED_CHECKIN_MAX_DATES = 45
ADULT_INBOX_YOUTH_MIXED_CUTOFF = dt.datetime(2025, 11, 1, tzinfo=dt.timezone.utc)
DAYSMART_TRIAL_HISTORY_START = dt.datetime(2023, 1, 1, tzinfo=dt.timezone.utc)
YOUTH_LEAD_TEXT_RE = re.compile(
    r"\b("
    r"youth|kid|kids|child|children|son|daughter|boy|girl|"
    r"seals?|cubs?|beach\s+lions?|junior|juniors|teen|teens|"
    r"ages?|age\s+\d+|u\d+|under\s+\d+|my\s+\d+\s*year\s*old"
    r")\b",
    re.I,
)
_ADMIN_CHECKIN_CACHE: dict[str, tuple[float, dict[int, list[dt.datetime]], dict[str, Any]]] = {}
_LIVE_REGISTRATION_CACHE: dict[int, tuple[float, list[dict[str, Any]]]] = {}
_PACK_CACHE: dict[int, tuple[float, str | None]] = {}
_PACK_PURCHASES_CACHE: tuple[float, dt.datetime, dict[int, list[tuple[dt.datetime, str]]]] | None = None
_SPEND_PURCHASES_CACHE: tuple[float, dt.datetime, dict[int, list[dt.datetime]]] | None = None
_DASHBOARD_BUILD_LOCK = threading.RLock()


def _synchronized(lock: threading.RLock) -> Any:
    def decorator(func: Any) -> Any:
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with lock:
                return func(*args, **kwargs)

        return wrapper

    return decorator


def _cache_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _dashboard_cache_key(
    *,
    adult_inbox_id: int,
    days: int,
    window: str | None,
    detail_level: str,
    namespace: str = "adult_kpis",
) -> str:
    normalized_window = (window or "").strip() or f"days:{days}"
    return f"{namespace}:v1:inbox:{adult_inbox_id}:window:{normalized_window}:detail:{detail_level}"


def _load_dashboard_cache(conn: Any, cache_key: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT payload_json FROM adult_kpi_dashboard_cache WHERE cache_key = ?",
        (cache_key,),
    ).fetchone()
    if row is None:
        return None
    return _json_loads(row["payload_json"], None)


def _save_dashboard_cache(conn: Any, cache_key: str, payload: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO adult_kpi_dashboard_cache (cache_key, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        """,
        (cache_key, json.dumps(payload), _cache_now_iso()),
    )


def _clear_dashboard_cache_rows(conn: Any, *, prefix: str | None = None) -> None:
    try:
        if prefix:
            conn.execute("DELETE FROM adult_kpi_dashboard_cache WHERE cache_key LIKE ?", (f"{prefix}%",))
        else:
            conn.execute("DELETE FROM adult_kpi_dashboard_cache")
    except sqlite3.OperationalError as exc:
        if "database is locked" not in str(exc).lower():
            raise


def clear_adult_kpi_caches(db_path: str) -> None:
    _ADMIN_CHECKIN_CACHE.clear()
    _LIVE_REGISTRATION_CACHE.clear()
    _PACK_CACHE.clear()
    global _PACK_PURCHASES_CACHE, _SPEND_PURCHASES_CACHE
    _PACK_PURCHASES_CACHE = None
    _SPEND_PURCHASES_CACHE = None
    with get_conn(db_path) as conn:
        _clear_dashboard_cache_rows(conn)


def _json_loads(value: str | None, fallback: Any) -> Any:
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _clean_text(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    text = value.replace("\u2019", "'")
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _normalize_daysmart_label(value: str | None) -> str:
    return _clean_text(value)


def _normalize_phone(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    digits = "".join(ch for ch in value if ch.isdigit())
    if len(digits) < 10:
        return None
    return digits[-10:]


def _normalize_email(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    return cleaned or None


def _normalize_name(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    ascii_like = "".join(
        ch for ch in unicodedata.normalize("NFKD", value) if not unicodedata.combining(ch)
    )
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in ascii_like)
    cleaned = " ".join(cleaned.split())
    return cleaned or None


def _as_int(value: Any) -> int | None:
    try:
        if value in (None, ""):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _money_to_float(value: Any) -> float:
    try:
        if value in (None, ""):
            return 0.0
        return float(str(value))
    except (TypeError, ValueError):
        return 0.0


def _purchase_pack_name(product_id: int | None, quantity: int | None) -> str | None:
    qty = quantity or 0
    if product_id == 86:
        return "10-Pack Classes"
    if product_id == 128:
        return "5-Pack Classes"
    if product_id == 192:
        if qty >= 10:
            return "10-Pack Classes"
        if qty >= 5:
            return "5-Pack Classes"
    return None


def _parse_ts(value: str | None, *, naive_tz: dt.tzinfo = dt.timezone.utc) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    cleaned = value.strip().replace("Z", "+00:00")
    for candidate in (cleaned, cleaned.replace(" ", "T")):
        try:
            parsed = dt.datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=naive_tz).astimezone(dt.timezone.utc)
            return parsed.astimezone(dt.timezone.utc)
        except ValueError:
            continue
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = dt.datetime.strptime(cleaned[:19], fmt)
            return parsed.replace(tzinfo=naive_tz).astimezone(dt.timezone.utc)
        except ValueError:
            continue
    return None


def _format_local(value: dt.datetime | None, *, with_time: bool = True) -> str:
    if value is None:
        return "--"
    local_value = value.astimezone(LOCAL_TZ)
    if with_time:
        return local_value.strftime("%a, %-m/%-d/%y %-I:%M %p")
    return local_value.strftime("%a, %-m/%-d/%y")


def _format_percent(numerator: int, denominator: int) -> str:
    if denominator <= 0:
        return "0%"
    return f"{round((numerator / denominator) * 100):.0f}%"


def _daysmart_account_url(customer_id: int | None) -> str | None:
    if customer_id is None:
        return None
    return (
        "https://apps.daysmartrecreation.com/dash/admin/index.php"
        f"?Action=CustomerInfo&CustomerID={customer_id}&company=qbksports"
    )


def _conversation_contact_name(conv: dict[str, Any]) -> str:
    if conv.get("contact_name"):
        return str(conv["contact_name"])
    payload = _json_loads(conv.get("raw_json"), {})
    contact = payload.get("contact") if isinstance(payload, dict) else {}
    if isinstance(contact, dict):
        return str(contact.get("full_name") or contact.get("name") or "Unknown")
    return "Unknown"


def _conversation_contact_phone(conv: dict[str, Any]) -> str | None:
    if conv.get("contact_number"):
        return str(conv["contact_number"])
    payload = _json_loads(conv.get("raw_json"), {})
    contact = payload.get("contact") if isinstance(payload, dict) else {}
    if isinstance(contact, dict):
        phone = contact.get("formatted_number") or contact.get("number") or contact.get("phone")
        return str(phone) if phone else None
    return None


def _conversation_contact_email(conv: dict[str, Any]) -> str | None:
    payload = _json_loads(conv.get("raw_json"), {})
    contact = payload.get("contact") if isinstance(payload, dict) else {}
    if isinstance(contact, dict):
        email = contact.get("email")
        return str(email) if email else None
    return None


def _find_adult_daysmart_customer(conn: Any, conv: dict[str, Any]) -> dict[str, Any] | None:
    phone = _normalize_phone(_conversation_contact_phone(conv))
    email = _normalize_email(_conversation_contact_email(conv))
    name = _normalize_name(_conversation_contact_name(conv))

    phone_matches: list[dict[str, Any]] = []
    if phone:
        rows = conn.execute(
            """
            SELECT *
            FROM daysmart_customers
            WHERE normalized_phone_day = ?
               OR normalized_phone_mobile = ?
               OR normalized_phone_night = ?
               OR normalized_phone_emergency = ?
            ORDER BY updated_at DESC
            LIMIT 10
            """,
            (phone, phone, phone, phone),
        ).fetchall()
        phone_matches = [dict(row) for row in rows]

    if phone_matches:
        if name:
            for row in phone_matches:
                if row.get("normalized_name") == name:
                    return row
        if email:
            for row in phone_matches:
                if row.get("normalized_email") == email:
                    return row
        return phone_matches[0]

    if email:
        row = conn.execute(
            """
            SELECT *
            FROM daysmart_customers
            WHERE normalized_email = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (email,),
        ).fetchone()
        if row is not None:
            return dict(row)

    if name:
        rows = conn.execute(
            """
            SELECT *
            FROM daysmart_customers
            WHERE normalized_name = ?
            ORDER BY updated_at DESC
            LIMIT 2
            """,
            (name,),
        ).fetchall()
        if len(rows) == 1:
            return dict(rows[0])

    return None


def _load_membership_map(conn: Any, customer_ids: set[int]) -> dict[int, list[str]]:
    if not customer_ids:
        return {}
    placeholders = ",".join("?" for _ in customer_ids)
    rows = conn.execute(
        f"""
        SELECT cm.customer_id, m.product_name, m.expires_at, m.created_at
        FROM daysmart_customer_memberships cm
        JOIN daysmart_memberships m ON m.membership_id = cm.membership_id
        WHERE cm.customer_id IN ({placeholders})
        ORDER BY cm.customer_id, coalesce(m.expires_at, m.created_at, '') DESC
        """,
        tuple(sorted(customer_ids)),
    ).fetchall()
    membership_map: dict[int, list[str]] = {}
    seen: dict[int, set[str]] = {}
    for row in rows:
        customer_id = int(row["customer_id"])
        seen.setdefault(customer_id, set())
        base = (row["product_name"] or "").strip() or "Unnamed membership"
        expires = (row["expires_at"] or "").strip()
        label = f"{base} ({expires[:10]})" if expires else base
        if label in seen[customer_id]:
            continue
        seen[customer_id].add(label)
        membership_map.setdefault(customer_id, []).append(label)
    return membership_map


def _is_staff_membership_label(label: str) -> bool:
    return "staff" in label.lower()


def _countable_membership_labels(labels: list[str]) -> list[str]:
    return [label for label in labels if not _is_staff_membership_label(label)]


def _has_gold_membership(labels: list[str]) -> bool:
    return any("gold" in label.lower() for label in _countable_membership_labels(labels))


def _has_dropin_membership(labels: list[str]) -> bool:
    return any("drop-in" in label.lower() or "drop in" in label.lower() for label in _countable_membership_labels(labels))


def _load_team_free_trial_details(
    client: DaysmartClient,
    team_id: int,
    cache: dict[int, dict[str, Any] | None],
) -> dict[str, Any] | None:
    cached = cache.get(team_id)
    if cached is not None:
        return cached
    try:
        payload = client._get(f"/api/v1/teams/{team_id}?include=events")
    except Exception:
        cache[team_id] = None
        return None

    team = payload.get("data") if isinstance(payload, dict) else None
    team_attrs = team.get("attributes") if isinstance(team, dict) and isinstance(team.get("attributes"), dict) else {}
    team_name = _normalize_daysmart_label(team_attrs.get("name"))
    is_known_trial_team = team_id in ADULT_FREE_TRIAL_TEAM_IDS
    if not is_known_trial_team and "free trial class" not in team_name.lower():
        cache[team_id] = None
        return None
    if is_known_trial_team and "free trial class" not in team_name.lower():
        team_name = "Free Trial Class - at QBK QUEENS"

    included = payload.get("included") if isinstance(payload, dict) and isinstance(payload.get("included"), list) else []
    event_starts: list[dt.datetime] = []
    for item in included:
        if not isinstance(item, dict) or item.get("type") != "events":
            continue
        attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
        home_team_id = _as_int(attrs.get("hteam_id"))
        if home_team_id != team_id:
            continue
        event_dt = _parse_ts(attrs.get("start") or attrs.get("start_gmt"), naive_tz=LOCAL_TZ)
        if event_dt is not None:
            event_starts.append(event_dt)
    event_starts.sort()
    cache[team_id] = {"team_name": team_name or "Free Trial Class", "event_starts": event_starts}
    return cache[team_id]


def _known_free_trial_event_lookup(client: DaysmartClient) -> dict[int, tuple[str, str | None]]:
    lookup: dict[int, tuple[str, str | None]] = {}
    team_cache: dict[int, dict[str, Any] | None] = {}
    for team_id in sorted(ADULT_FREE_TRIAL_TEAM_IDS):
        team_details = _load_team_free_trial_details(client, team_id, team_cache)
        if not team_details:
            continue
        try:
            payload = client._get(f"/api/v1/teams/{team_id}?include=events")
        except Exception:
            continue
        included = payload.get("included") if isinstance(payload, dict) and isinstance(payload.get("included"), list) else []
        for item in included:
            if not isinstance(item, dict) or item.get("type") != "events":
                continue
            event_id = _as_int(item.get("id"))
            attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
            if event_id is None or _as_int(attrs.get("hteam_id")) != team_id:
                continue
            event_start = attrs.get("start") or attrs.get("start_gmt")
            lookup[event_id] = (str(team_details["team_name"] or "Free Trial Class"), event_start)
    return lookup


def _infer_registration_event_start(
    registration: dict[str, Any],
    *,
    team_details: dict[str, Any] | None,
) -> str | None:
    if not team_details:
        return None
    event_starts: list[dt.datetime] = list(team_details.get("event_starts") or [])
    if not event_starts:
        return None
    created_dt = _parse_ts(registration.get("created_at"), naive_tz=LOCAL_TZ)
    if created_dt is None:
        return event_starts[0].isoformat()
    chosen = min(
        event_starts,
        key=lambda event_dt: abs((event_dt - created_dt).total_seconds()),
    )
    return chosen.isoformat()


def _load_event_free_trial_details(
    client: DaysmartClient,
    event_id: int,
    *,
    team_cache: dict[int, dict[str, Any] | None],
    event_cache: dict[int, dict[str, Any] | None],
) -> dict[str, Any] | None:
    cached = event_cache.get(event_id)
    if cached is not None:
        return cached
    try:
        payload = client.get_event(event_id)
    except Exception:
        event_cache[event_id] = None
        return None
    attrs = payload.get("attributes") if isinstance(payload.get("attributes"), dict) else {}
    event_start = _parse_ts(attrs.get("start") or attrs.get("start_gmt"), naive_tz=LOCAL_TZ)
    team_id = _as_int(attrs.get("hteam_id"))
    team_details = _load_team_free_trial_details(client, team_id, team_cache) if team_id is not None else None
    if team_details:
        event_cache[event_id] = {
            "event_name": team_details["team_name"],
            "event_start": event_start.isoformat() if event_start else None,
        }
        return event_cache[event_id]
    label = _normalize_daysmart_label(attrs.get("desc") or attrs.get("name"))
    if "free trial class" not in label.lower():
        event_cache[event_id] = None
        return None
    event_cache[event_id] = {
        "event_name": label,
        "event_start": event_start.isoformat() if event_start else None,
    }
    return event_cache[event_id]


def _load_live_customer_free_trial_registrations(
    client: DaysmartClient,
    customer_id: int,
    *,
    conn: Any | None,
    team_cache: dict[int, dict[str, Any] | None],
    event_detail_cache: dict[int, dict[str, Any] | None],
) -> list[dict[str, Any]]:
    cached = _LIVE_REGISTRATION_CACHE.get(customer_id)
    now_ts = time.time()
    if cached and now_ts - cached[0] <= LOOKUP_CACHE_TTL_SECONDS:
        return list(cached[1])

    if conn is not None:
        row = conn.execute(
            "SELECT registrations_json FROM daysmart_live_registration_cache WHERE customer_id = ?",
            (customer_id,),
        ).fetchone()
        if row is not None:
            cached_regs = _json_loads(row["registrations_json"], [])
            if isinstance(cached_regs, list):
                _LIVE_REGISTRATION_CACHE[customer_id] = (now_ts, cached_regs)
                return list(cached_regs)

    registrations: list[dict[str, Any]] = []

    try:
        payload = client._get(
            "/api/v1/registrations",
            params={
                "filter[customer_id]": customer_id,
                "page[number]": 1,
                "page[size]": 50,
            },
        )
    except Exception:
        payload = {}
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), list) else []
    for row in data:
        attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
        team_id = _as_int(attrs.get("team_id"))
        if team_id is None:
            continue
        team_details = _load_team_free_trial_details(client, team_id, team_cache)
        if not team_details:
            continue
        created_at = attrs.get("create_date") or attrs.get("created_at") or attrs.get("updated_at")
        registration = {
            "source_type": "registration",
            "registration_id": _as_int(row.get("id")),
            "customer_id": customer_id,
            "team_or_event_id": team_id,
            "event_name": team_details["team_name"],
            "event_start": _infer_registration_event_start({"created_at": created_at}, team_details=team_details),
            "created_at": created_at,
        }
        registrations.append(registration)

    try:
        payload = client._get(
            "/api/v1/event-registrations",
            params={
                "filter[customer_id]": customer_id,
                "page[number]": 1,
                "page[size]": 50,
            },
        )
    except Exception:
        payload = {}
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), list) else []
    for row in data:
        attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
        event_id = _as_int(attrs.get("event_id"))
        if event_id is None:
            continue
        event_details = _load_event_free_trial_details(
            client,
            event_id,
            team_cache=team_cache,
            event_cache=event_detail_cache,
        )
        if not event_details:
            continue
        registrations.append(
            {
                "source_type": "event_registration",
                "registration_id": _as_int(row.get("id")),
                "customer_id": customer_id,
                "team_or_event_id": event_id,
                "event_name": event_details["event_name"],
                "event_start": event_details["event_start"],
                "created_at": attrs.get("time") or attrs.get("created_at") or attrs.get("updated_at"),
            }
        )

    deduped: dict[tuple[str, int | None], dict[str, Any]] = {}
    for registration in registrations:
        key = (str(registration.get("source_type") or ""), _as_int(registration.get("registration_id")))
        deduped[key] = registration
    result = list(deduped.values())
    if conn is not None:
        conn.execute(
            """
            INSERT INTO daysmart_live_registration_cache (customer_id, registrations_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(customer_id) DO UPDATE SET
                registrations_json = excluded.registrations_json,
                updated_at = excluded.updated_at
            """,
            (customer_id, json.dumps(result), _cache_now_iso()),
        )
    _LIVE_REGISTRATION_CACHE[customer_id] = (now_ts, result)
    return list(result)


def _load_registration_map(
    conn: Any,
    customer_ids: set[int],
    *,
    client: DaysmartClient | None,
    allow_live_fallback: bool = True,
) -> dict[int, list[dict[str, Any]]]:
    if not customer_ids:
        return {}
    placeholders = ",".join("?" for _ in customer_ids)
    rows = conn.execute(
        f"""
        SELECT source_type, registration_id, customer_id, team_or_event_id, event_name, event_start, created_at
        FROM daysmart_class_registrations
        WHERE source_type IN ('event_registration', 'registration')
          AND customer_id IN ({placeholders})
        ORDER BY customer_id ASC, coalesce(event_start, created_at, '') ASC, registration_id ASC
        """,
        tuple(sorted(customer_ids)),
    ).fetchall()
    registration_map: dict[int, list[dict[str, Any]]] = {}
    team_cache: dict[int, dict[str, Any] | None] = {}
    event_detail_cache: dict[int, dict[str, Any] | None] = {}
    for row in rows:
        registration = dict(row)
        source_type = str(registration.get("source_type") or "")
        if source_type == "event_registration":
            event_name = _normalize_daysmart_label(registration.get("event_name"))
            if "free trial class" not in event_name.lower():
                continue
            registration["event_name"] = event_name
            registration_map.setdefault(int(registration["customer_id"]), []).append(registration)
            continue

        if client is None:
            event_name = _normalize_daysmart_label(registration.get("event_name"))
            if "free trial class" not in event_name.lower():
                continue
            registration["event_name"] = event_name
            registration_map.setdefault(int(registration["customer_id"]), []).append(registration)
            continue

        team_id = _as_int(registration.get("team_or_event_id"))
        if team_id is None:
            continue
        team_details = _load_team_free_trial_details(client, team_id, team_cache)
        if not team_details:
            continue
        registration["event_name"] = team_details["team_name"]
        registration["event_start"] = _infer_registration_event_start(registration, team_details=team_details)
        registration_map.setdefault(int(registration["customer_id"]), []).append(registration)

    if not allow_live_fallback or client is None:
        return registration_map

    missing_customer_ids = sorted(customer_ids - set(registration_map))
    for customer_id in missing_customer_ids:
        live_regs = _load_live_customer_free_trial_registrations(
            client,
            customer_id,
            conn=conn,
            team_cache=team_cache,
            event_detail_cache=event_detail_cache,
        )
        if live_regs:
            registration_map[customer_id] = live_regs
    return registration_map


def _latest_pack_purchase(
    client: DaysmartClient,
    customer_id: int,
    *,
    conn: Any | None = None,
    force_live: bool = False,
) -> str | None:
    cached = _PACK_CACHE.get(customer_id)
    now_ts = time.time()
    if not force_live and cached and now_ts - cached[0] <= LOOKUP_CACHE_TTL_SECONDS:
        return cached[1]

    if conn is not None and not force_live:
        row = conn.execute(
            "SELECT pack_name FROM daysmart_pack_cache WHERE customer_id = ?",
            (customer_id,),
        ).fetchone()
        if row is not None:
            pack_name = row["pack_name"]
            _PACK_CACHE[customer_id] = (now_ts, pack_name)
            return pack_name

    page = 1
    while True:
        rows, last_page = client.list_invoice_items(
            page_number=page,
            page_size=100,
            filters={"customer_id": customer_id},
            sort="-date",
        )
        if not rows:
            return None
        for row in rows:
            attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
            product_id = _as_int(attrs.get("product_id"))
            if product_id not in PACK_PRODUCT_IDS:
                continue
            quantity = _as_int(attrs.get("quantity")) or 0
            price_value = _money_to_float(attrs.get("price"))
            if (
                price_value <= 0
                or quantity <= 1
                or _as_int(attrs.get("parent_invoice_item_id"))
                or _as_int(attrs.get("reversed_item_id"))
            ):
                continue
            result = _purchase_pack_name(product_id, quantity)
            if conn is not None:
                conn.execute(
                    """
                    INSERT INTO daysmart_pack_cache (customer_id, pack_name, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(customer_id) DO UPDATE SET
                        pack_name = excluded.pack_name,
                        updated_at = excluded.updated_at
                    """,
                    (customer_id, result, _cache_now_iso()),
                )
            _PACK_CACHE[customer_id] = (now_ts, result)
            return result
        if page >= last_page:
            if conn is not None:
                conn.execute(
                    """
                    INSERT INTO daysmart_pack_cache (customer_id, pack_name, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(customer_id) DO UPDATE SET
                        pack_name = excluded.pack_name,
                        updated_at = excluded.updated_at
                    """,
                    (customer_id, None, _cache_now_iso()),
                )
            _PACK_CACHE[customer_id] = (now_ts, None)
            return None
        page += 1


def _load_pack_map(client: DaysmartClient, customer_ids: set[int], *, conn: Any | None = None) -> dict[int, str]:
    pack_map: dict[int, str] = {}
    for customer_id in sorted(customer_ids):
        try:
            pack_name = _latest_pack_purchase(client, customer_id, conn=conn)
        except Exception:
            pack_name = None
        if pack_name:
            pack_map[customer_id] = pack_name
    return pack_map


def _load_pack_purchases_since(
    client: DaysmartClient,
    *,
    cutoff: dt.datetime,
    page_size: int = 200,
) -> dict[int, list[tuple[dt.datetime, str]]]:
    global _PACK_PURCHASES_CACHE
    now_ts = time.time()
    cached = _PACK_PURCHASES_CACHE
    if cached and now_ts - cached[0] <= LOOKUP_CACHE_TTL_SECONDS and cached[1] <= cutoff:
        return cached[2]

    purchases: dict[int, list[tuple[dt.datetime, str]]] = {}
    for product_id in sorted(PACK_PRODUCT_IDS):
        page = 1
        while True:
            rows, last_page = client.list_invoice_items(
                page_number=page,
                page_size=page_size,
                filters={"product_id": product_id},
                sort="-date",
            )
            page_dates: list[dt.datetime] = []
            for row in rows:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                item_dt = _parse_ts(
                    attrs.get("date") or attrs.get("created_gmt") or attrs.get("created_at"),
                    naive_tz=LOCAL_TZ,
                )
                if item_dt is not None:
                    page_dates.append(item_dt)
                    if item_dt < cutoff:
                        continue
                quantity = _as_int(attrs.get("quantity")) or 0
                price_value = _money_to_float(attrs.get("price"))
                if (
                    item_dt is None
                    or price_value <= 0
                    or quantity <= 1
                    or _as_int(attrs.get("parent_invoice_item_id"))
                    or _as_int(attrs.get("reversed_item_id"))
                ):
                    continue
                customer_id = _as_int(attrs.get("customer_id"))
                pack_name = _purchase_pack_name(product_id, quantity)
                if customer_id is not None and pack_name:
                    purchases.setdefault(customer_id, []).append((item_dt, pack_name))
            if page >= last_page:
                break
            if page_dates and min(page_dates) < cutoff:
                break
            page += 1

    for customer_purchases in purchases.values():
        customer_purchases.sort(key=lambda item: item[0])
    _PACK_PURCHASES_CACHE = (now_ts, cutoff, purchases)
    return purchases


def _load_pack_map_after_trial_window(
    client: DaysmartClient,
    trial_dates_by_customer: dict[int, dt.datetime],
    *,
    window_days: int = 30,
    page_size: int = 200,
) -> dict[int, str]:
    if not trial_dates_by_customer:
        return {}

    earliest_trial = min(trial_dates_by_customer.values())
    latest_window_end = max(
        trial_dt + dt.timedelta(days=window_days)
        for trial_dt in trial_dates_by_customer.values()
    )
    purchase_map = _load_pack_purchases_since(client, cutoff=earliest_trial, page_size=page_size)
    found_packs: dict[int, str] = {}
    for customer_id, trial_dt in trial_dates_by_customer.items():
        for item_dt, pack_name in purchase_map.get(customer_id, []):
            if item_dt > latest_window_end:
                break
            if trial_dt <= item_dt <= trial_dt + dt.timedelta(days=window_days):
                found_packs[customer_id] = pack_name
                break
    return found_packs


def _ensure_trial_pack_window_cache_table(conn: Any) -> None:
    existing = conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'daysmart_trial_pack_window_cache'
        """
    ).fetchone()
    if existing is not None:
        pk_columns = [
            row["name"]
            for row in conn.execute("PRAGMA table_info(daysmart_trial_pack_window_cache)").fetchall()
            if row["pk"]
        ]
        if pk_columns == ["customer_id"]:
            conn.execute(
                "ALTER TABLE daysmart_trial_pack_window_cache RENAME TO daysmart_trial_pack_window_cache_old"
            )
            conn.execute(
                """
                CREATE TABLE daysmart_trial_pack_window_cache (
                    customer_id INTEGER NOT NULL,
                    trial_at TEXT NOT NULL,
                    pack_name TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (customer_id, trial_at)
                )
                """
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO daysmart_trial_pack_window_cache
                    (customer_id, trial_at, pack_name, updated_at)
                SELECT customer_id, trial_at, pack_name, updated_at
                FROM daysmart_trial_pack_window_cache_old
                WHERE trial_at IS NOT NULL
                """
            )
            conn.execute("DROP TABLE daysmart_trial_pack_window_cache_old")
            return
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daysmart_trial_pack_window_cache (
            customer_id INTEGER NOT NULL,
            trial_at TEXT NOT NULL,
            pack_name TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (customer_id, trial_at)
        )
        """
    )


def _load_cached_pack_map_after_trial_window(
    conn: Any,
    trial_dates_by_customer: dict[int, dt.datetime],
) -> tuple[dict[int, str], set[int]]:
    if not trial_dates_by_customer:
        return {}, set()
    _ensure_trial_pack_window_cache_table(conn)
    placeholders = ",".join("?" for _ in trial_dates_by_customer)
    rows = conn.execute(
        f"""
        SELECT customer_id, trial_at, pack_name
        FROM daysmart_trial_pack_window_cache
        WHERE customer_id IN ({placeholders})
        """,
        tuple(sorted(trial_dates_by_customer)),
    ).fetchall()
    pack_map: dict[int, str] = {}
    cached_customer_ids: set[int] = set()
    for row in rows:
        customer_id = _as_int(row["customer_id"])
        if customer_id is None:
            continue
        trial_dt = trial_dates_by_customer.get(customer_id)
        cached_trial_dt = _parse_ts(row["trial_at"])
        if trial_dt is None or cached_trial_dt is None:
            continue
        if cached_trial_dt != trial_dt:
            continue
        cached_customer_ids.add(customer_id)
        if row["pack_name"]:
            pack_map[customer_id] = row["pack_name"]
    return pack_map, cached_customer_ids


def _save_pack_map_after_trial_window_cache(
    conn: Any,
    trial_dates_by_customer: dict[int, dt.datetime],
    pack_map: dict[int, str],
) -> None:
    _ensure_trial_pack_window_cache_table(conn)
    now_iso = _cache_now_iso()
    for customer_id, trial_dt in sorted(trial_dates_by_customer.items()):
        conn.execute(
            """
            INSERT INTO daysmart_trial_pack_window_cache (customer_id, trial_at, pack_name, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(customer_id, trial_at) DO UPDATE SET
                pack_name = excluded.pack_name,
                updated_at = excluded.updated_at
            """,
            (customer_id, trial_dt.isoformat(), pack_map.get(customer_id), now_iso),
        )


def _trial_pack_entry_key(customer_id: int, trial_dt: dt.datetime) -> str:
    return f"{customer_id}|{trial_dt.isoformat()}"


def _load_pack_map_after_trial_entries(
    client: DaysmartClient,
    trial_dates_by_entry: dict[str, tuple[int, dt.datetime]],
    *,
    window_days: int = 30,
    page_size: int = 200,
) -> dict[str, str]:
    if not trial_dates_by_entry:
        return {}

    earliest_trial = min(trial_dt for _, trial_dt in trial_dates_by_entry.values())
    latest_window_end = max(
        trial_dt + dt.timedelta(days=window_days)
        for _, trial_dt in trial_dates_by_entry.values()
    )
    purchase_map = _load_pack_purchases_since(client, cutoff=earliest_trial, page_size=page_size)
    found_packs: dict[str, str] = {}
    for entry_key, (customer_id, trial_dt) in trial_dates_by_entry.items():
        for item_dt, pack_name in purchase_map.get(customer_id, []):
            if item_dt > latest_window_end:
                break
            if trial_dt <= item_dt <= trial_dt + dt.timedelta(days=window_days):
                found_packs[entry_key] = pack_name
                break
    return found_packs


def _load_cached_pack_map_after_trial_entries(
    conn: Any,
    trial_dates_by_entry: dict[str, tuple[int, dt.datetime]],
) -> tuple[dict[str, str], set[str]]:
    if not trial_dates_by_entry:
        return {}, set()
    _ensure_trial_pack_window_cache_table(conn)
    customer_ids = sorted({customer_id for customer_id, _ in trial_dates_by_entry.values()})
    placeholders = ",".join("?" for _ in customer_ids)
    rows = conn.execute(
        f"""
        SELECT customer_id, trial_at, pack_name
        FROM daysmart_trial_pack_window_cache
        WHERE customer_id IN ({placeholders})
        """,
        tuple(customer_ids),
    ).fetchall()
    requested_by_customer_trial = {
        (customer_id, trial_dt): entry_key
        for entry_key, (customer_id, trial_dt) in trial_dates_by_entry.items()
    }
    pack_map: dict[str, str] = {}
    cached_entry_keys: set[str] = set()
    for row in rows:
        customer_id = _as_int(row["customer_id"])
        cached_trial_dt = _parse_ts(row["trial_at"])
        if customer_id is None or cached_trial_dt is None:
            continue
        entry_key = requested_by_customer_trial.get((customer_id, cached_trial_dt))
        if entry_key is None:
            continue
        cached_entry_keys.add(entry_key)
        if row["pack_name"]:
            pack_map[entry_key] = row["pack_name"]
    return pack_map, cached_entry_keys


def _save_pack_map_after_trial_entries_cache(
    conn: Any,
    trial_dates_by_entry: dict[str, tuple[int, dt.datetime]],
    pack_map: dict[str, str],
) -> None:
    _ensure_trial_pack_window_cache_table(conn)
    now_iso = _cache_now_iso()
    for entry_key, (customer_id, trial_dt) in sorted(trial_dates_by_entry.items()):
        conn.execute(
            """
            INSERT INTO daysmart_trial_pack_window_cache (customer_id, trial_at, pack_name, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(customer_id, trial_at) DO UPDATE SET
                pack_name = excluded.pack_name,
                updated_at = excluded.updated_at
            """,
            (customer_id, trial_dt.isoformat(), pack_map.get(entry_key), now_iso),
        )


def _load_spend_purchases_since(
    client: DaysmartClient,
    *,
    cutoff: dt.datetime,
    page_size: int = 200,
) -> dict[int, list[dt.datetime]]:
    global _SPEND_PURCHASES_CACHE
    now_ts = time.time()
    cached = _SPEND_PURCHASES_CACHE
    if cached and now_ts - cached[0] <= LOOKUP_CACHE_TTL_SECONDS and cached[1] <= cutoff:
        return cached[2]

    purchases: dict[int, list[dt.datetime]] = {}
    page = 1
    while True:
        rows, last_page = client.list_invoice_items(
            page_number=page,
            page_size=page_size,
            sort="-date",
        )
        page_dates: list[dt.datetime] = []
        for row in rows:
            attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
            item_dt = _parse_ts(
                attrs.get("date") or attrs.get("created_gmt") or attrs.get("created_at"),
                naive_tz=LOCAL_TZ,
            )
            if item_dt is not None:
                page_dates.append(item_dt)
                if item_dt < cutoff:
                    continue
            if (
                item_dt is None
                or _money_to_float(attrs.get("price")) <= 0
                or _as_int(attrs.get("parent_invoice_item_id"))
                or _as_int(attrs.get("reversed_item_id"))
            ):
                continue
            customer_id = _as_int(attrs.get("customer_id"))
            if customer_id is not None:
                purchases.setdefault(customer_id, []).append(item_dt)
        if page >= last_page:
            break
        if page_dates and min(page_dates) < cutoff:
            break
        page += 1

    for customer_purchases in purchases.values():
        customer_purchases.sort()
    _SPEND_PURCHASES_CACHE = (now_ts, cutoff, purchases)
    return purchases


def _load_spend_map_after_trial(
    client: DaysmartClient,
    trial_dates_by_customer: dict[int, dt.datetime],
    *,
    page_size: int = 200,
) -> dict[int, bool]:
    if not trial_dates_by_customer:
        return {}

    earliest_trial = min(trial_dates_by_customer.values())
    purchase_map = _load_spend_purchases_since(client, cutoff=earliest_trial, page_size=page_size)
    found_spend: dict[int, bool] = {}
    for customer_id, trial_dt in trial_dates_by_customer.items():
        for item_dt in purchase_map.get(customer_id, []):
            if item_dt >= trial_dt:
                found_spend[customer_id] = True
                break
    return found_spend


def _ensure_spend_cache_table(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daysmart_spend_cache (
            customer_id INTEGER PRIMARY KEY,
            latest_spend_at TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )


def _load_cached_spend_map_after_trial(
    conn: Any,
    trial_dates_by_customer: dict[int, dt.datetime],
) -> tuple[dict[int, bool], set[int]]:
    if not trial_dates_by_customer:
        return {}, set()
    _ensure_spend_cache_table(conn)
    placeholders = ",".join("?" for _ in trial_dates_by_customer)
    rows = conn.execute(
        f"""
        SELECT customer_id, latest_spend_at
        FROM daysmart_spend_cache
        WHERE customer_id IN ({placeholders})
        """,
        tuple(sorted(trial_dates_by_customer)),
    ).fetchall()
    spend_map: dict[int, bool] = {}
    cached_customer_ids: set[int] = set()
    for row in rows:
        customer_id = _as_int(row["customer_id"])
        if customer_id is None:
            continue
        cached_customer_ids.add(customer_id)
        latest_spend_at = _parse_ts(row["latest_spend_at"])
        trial_dt = trial_dates_by_customer.get(customer_id)
        if latest_spend_at is not None and trial_dt is not None and latest_spend_at >= trial_dt:
            spend_map[customer_id] = True
    return spend_map, cached_customer_ids


def refresh_historical_daysmart_trial_spend_cache(
    db_path: str,
    *,
    page_size: int = 200,
    start_at: dt.datetime | None = None,
) -> dict[str, Any]:
    """Backfill latest positive DaySmart spend for every historical trial attendee."""
    global _SPEND_PURCHASES_CACHE
    cutoff = start_at or DAYSMART_TRIAL_HISTORY_START
    team_placeholders = ",".join("?" for _ in ADULT_FREE_TRIAL_TEAM_IDS)
    with get_conn(db_path) as conn:
        _ensure_spend_cache_table(conn)
        rows = conn.execute(
            f"""
            SELECT DISTINCT customer_id
            FROM daysmart_class_registrations
            WHERE customer_id IS NOT NULL
              AND coalesce(event_start, created_at, '') >= ?
              AND (
                (source_type = 'event_registration' AND lower(coalesce(event_name, '')) LIKE '%free trial class%')
                OR (source_type = 'registration' AND team_or_event_id IN ({team_placeholders}))
              )
            """,
            (cutoff.isoformat(), *sorted(ADULT_FREE_TRIAL_TEAM_IDS)),
        ).fetchall()
        trial_customer_ids = {
            customer_id
            for row in rows
            if (customer_id := _as_int(row["customer_id"])) is not None
        }
    roster_customers = _load_roster_csv_customers(
        window_start=cutoff.date().isoformat(),
        window_end_exclusive=(dt.date.today() + dt.timedelta(days=1)).isoformat(),
    )
    trial_customer_ids.update(roster_customers)

    if not trial_customer_ids:
        return {
            "ok": True,
            "customers_in_scope": 0,
            "invoice_pages_scanned": 0,
            "invoice_items_seen": 0,
            "spenders": 0,
        }

    with get_conn(db_path) as conn:
        _ensure_spend_cache_table(conn)
        placeholders = ",".join("?" for _ in trial_customer_ids)
        cached_rows = conn.execute(
            f"SELECT customer_id FROM daysmart_spend_cache WHERE customer_id IN ({placeholders})",
            tuple(sorted(trial_customer_ids)),
        ).fetchall()
        cached_customer_ids = {
            customer_id
            for row in cached_rows
            if (customer_id := _as_int(row["customer_id"])) is not None
        }

    latest_spend_by_customer: dict[int, dt.datetime] = {}
    pages_scanned = 0
    invoice_items_seen = 0
    client = _daysmart_client()
    pending_rows: list[tuple[int, str | None]] = []

    def flush_pending() -> None:
        if not pending_rows:
            return
        now_iso = _cache_now_iso()
        with get_conn(db_path) as conn:
            _ensure_spend_cache_table(conn)
            for row_customer_id, row_latest_spend_at in pending_rows:
                conn.execute(
                    """
                    INSERT INTO daysmart_spend_cache (customer_id, latest_spend_at, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(customer_id) DO UPDATE SET
                        latest_spend_at = excluded.latest_spend_at,
                        updated_at = excluded.updated_at
                    """,
                    (row_customer_id, row_latest_spend_at, now_iso),
                )
        pending_rows.clear()

    customers_to_refresh = sorted(trial_customer_ids - cached_customer_ids)
    for customer_id in customers_to_refresh:
        page = 1
        latest_spend_at: dt.datetime | None = None
        while True:
            rows, last_page = client.list_invoice_items(
                page_number=page,
                page_size=min(page_size, 100),
                filters={"customer_id": customer_id},
                sort="-date",
            )
            pages_scanned += 1
            invoice_items_seen += len(rows)
            page_dates: list[dt.datetime] = []
            found_for_customer = False
            for row in rows:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                item_dt = _parse_ts(
                    attrs.get("date") or attrs.get("created_gmt") or attrs.get("created_at"),
                    naive_tz=LOCAL_TZ,
                )
                if item_dt is not None:
                    page_dates.append(item_dt)
                    if item_dt < cutoff:
                        continue
                if (
                    item_dt is None
                    or _money_to_float(attrs.get("price")) <= 0
                    or _as_int(attrs.get("parent_invoice_item_id"))
                    or _as_int(attrs.get("reversed_item_id"))
                ):
                    continue
                latest_spend_at = item_dt
                latest_spend_by_customer[customer_id] = item_dt
                found_for_customer = True
                break
            if found_for_customer or page >= last_page:
                break
            if page_dates and min(page_dates) < cutoff:
                break
            page += 1
        pending_rows.append((customer_id, latest_spend_at.isoformat() if latest_spend_at else None))
        if len(pending_rows) >= 25:
            flush_pending()

    flush_pending()
    with get_conn(db_path) as conn:
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")
    _SPEND_PURCHASES_CACHE = None
    with get_conn(db_path) as conn:
        _ensure_spend_cache_table(conn)
        spender_count = conn.execute(
            """
            SELECT count(*) AS c
            FROM daysmart_spend_cache
            WHERE latest_spend_at IS NOT NULL
            """
        ).fetchone()["c"]
    return {
        "ok": True,
        "customers_in_scope": len(trial_customer_ids),
        "customers_cached_before": len(cached_customer_ids),
        "customers_refreshed": len(customers_to_refresh),
        "invoice_pages_scanned": pages_scanned,
        "invoice_items_seen": invoice_items_seen,
        "spenders": spender_count,
    }


def refresh_recent_daysmart_trial_pack_cache(
    db_path: str,
    *,
    days_back: int = 45,
) -> dict[str, Any]:
    """Refresh pack caches for recent trial attendees so new pack buys show up."""
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_back)).isoformat()
    team_placeholders = ",".join("?" for _ in ADULT_FREE_TRIAL_TEAM_IDS)
    with get_conn(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT customer_id, event_start, created_at
            FROM daysmart_class_registrations
            WHERE customer_id IS NOT NULL
              AND (
                (source_type = 'event_registration' AND lower(coalesce(event_name, '')) LIKE '%free trial class%')
                OR (source_type = 'registration' AND team_or_event_id IN ({team_placeholders}))
              )
              AND coalesce(event_start, created_at, '') >= ?
            ORDER BY customer_id ASC
            """,
            (*sorted(ADULT_FREE_TRIAL_TEAM_IDS), cutoff),
        ).fetchall()
        trial_dates_by_customer: dict[int, dt.datetime] = {}
        for row in rows:
            customer_id = _as_int(row["customer_id"])
            if customer_id is None:
                continue
            trial_dt = _parse_ts(row["event_start"] or row["created_at"], naive_tz=LOCAL_TZ)
            if trial_dt is None:
                continue
            existing_dt = trial_dates_by_customer.get(customer_id)
            if existing_dt is None or trial_dt > existing_dt:
                trial_dates_by_customer[customer_id] = trial_dt

    client = _daysmart_client()
    window_pack_map = _load_pack_map_after_trial_window(client, trial_dates_by_customer, window_days=30)
    now_iso = _cache_now_iso()
    with get_conn(db_path) as conn:
        _save_pack_map_after_trial_window_cache(conn, trial_dates_by_customer, window_pack_map)
        for customer_id in sorted(trial_dates_by_customer):
            pack_name = window_pack_map.get(customer_id)
            conn.execute(
                """
                INSERT INTO daysmart_pack_cache (customer_id, pack_name, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(customer_id) DO UPDATE SET
                    pack_name = excluded.pack_name,
                    updated_at = excluded.updated_at
                """,
                (customer_id, pack_name, now_iso),
            )
            _PACK_CACHE[customer_id] = (time.time(), pack_name)
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")
    return {
        "ok": True,
        "days_back": days_back,
        "customers_refreshed": len(trial_dates_by_customer),
        "pack_buyers": len(window_pack_map),
    }


def _latest_positive_spend(
    client: DaysmartClient,
    customer_id: int,
    *,
    cutoff: dt.datetime = DAYSMART_TRIAL_HISTORY_START,
    page_size: int = 100,
) -> dt.datetime | None:
    page = 1
    while True:
        rows, last_page = client.list_invoice_items(
            page_number=page,
            page_size=page_size,
            filters={"customer_id": customer_id},
            sort="-date",
        )
        page_dates: list[dt.datetime] = []
        for row in rows:
            attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
            item_dt = _parse_ts(
                attrs.get("date") or attrs.get("created_gmt") or attrs.get("created_at"),
                naive_tz=LOCAL_TZ,
            )
            if item_dt is not None:
                page_dates.append(item_dt)
                if item_dt < cutoff:
                    continue
            if (
                item_dt is None
                or _money_to_float(attrs.get("price")) <= 0
                or _as_int(attrs.get("parent_invoice_item_id"))
                or _as_int(attrs.get("reversed_item_id"))
            ):
                continue
            return item_dt
        if page >= last_page:
            return None
        if page_dates and min(page_dates) < cutoff:
            return None
        page += 1


def _load_latest_trial_dates_by_customer(conn: Any) -> dict[int, dt.datetime]:
    team_placeholders = ",".join("?" for _ in ADULT_FREE_TRIAL_TEAM_IDS)
    rows = conn.execute(
        f"""
        SELECT customer_id, max(coalesce(event_start, created_at)) AS trial_at
        FROM daysmart_class_registrations
        WHERE customer_id IS NOT NULL
          AND coalesce(event_start, created_at, '') >= ?
          AND (
            (source_type = 'event_registration' AND lower(coalesce(event_name, '')) LIKE '%free trial class%')
            OR (source_type = 'registration' AND team_or_event_id IN ({team_placeholders}))
          )
        GROUP BY customer_id
        """,
        (DAYSMART_TRIAL_HISTORY_START.isoformat(), *sorted(ADULT_FREE_TRIAL_TEAM_IDS)),
    ).fetchall()
    trial_dates: dict[int, dt.datetime] = {}
    for row in rows:
        customer_id = _as_int(row["customer_id"])
        trial_at = _parse_ts(row["trial_at"], naive_tz=LOCAL_TZ)
        if customer_id is not None and trial_at is not None:
            trial_dates[customer_id] = trial_at
    return trial_dates


def _refresh_recent_spend_events_for_historical_trials(
    db_path: str,
    *,
    days_back: int,
    page_size: int = 200,
) -> dict[str, Any]:
    """Catch new invoice activity from old trial attendees without recrawling every customer."""
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_back)
    client = _daysmart_client()
    recent_purchase_map = _load_spend_purchases_since(client, cutoff=cutoff, page_size=page_size)
    if not recent_purchase_map:
        return {
            "ok": True,
            "days_back": days_back,
            "recent_spend_customers_seen": 0,
            "historical_trial_spenders_refreshed": 0,
        }

    now_iso = _cache_now_iso()
    refreshed = 0
    with get_conn(db_path) as conn:
        _ensure_spend_cache_table(conn)
        trial_dates = _load_latest_trial_dates_by_customer(conn)
        for customer_id, purchase_dates in sorted(recent_purchase_map.items()):
            trial_at = trial_dates.get(customer_id)
            if trial_at is None:
                continue
            spend_after_trial = [purchase_dt for purchase_dt in purchase_dates if purchase_dt >= trial_at]
            if not spend_after_trial:
                continue
            latest_recent_spend_at = max(spend_after_trial)
            existing_row = conn.execute(
                "SELECT latest_spend_at FROM daysmart_spend_cache WHERE customer_id = ?",
                (customer_id,),
            ).fetchone()
            existing_spend_at = (
                _parse_ts(existing_row["latest_spend_at"])
                if existing_row is not None and existing_row["latest_spend_at"]
                else None
            )
            latest_spend_at = max(
                [value for value in (existing_spend_at, latest_recent_spend_at) if value is not None]
            )
            conn.execute(
                """
                INSERT INTO daysmart_spend_cache (customer_id, latest_spend_at, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(customer_id) DO UPDATE SET
                    latest_spend_at = excluded.latest_spend_at,
                    updated_at = excluded.updated_at
                """,
                (customer_id, latest_spend_at.isoformat(), now_iso),
            )
            refreshed += 1
        if refreshed:
            _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")
    return {
        "ok": True,
        "days_back": days_back,
        "recent_spend_customers_seen": len(recent_purchase_map),
        "historical_trial_spenders_refreshed": refreshed,
    }


def refresh_recent_daysmart_trial_spend_cache(
    db_path: str,
    *,
    days_back: int = 90,
) -> dict[str, Any]:
    """Refresh spend cache for recent trial attendees without redoing all-time history."""
    global _SPEND_PURCHASES_CACHE
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_back)).isoformat()
    team_placeholders = ",".join("?" for _ in ADULT_FREE_TRIAL_TEAM_IDS)
    with get_conn(db_path) as conn:
        _ensure_spend_cache_table(conn)
        rows = conn.execute(
            f"""
            SELECT DISTINCT customer_id
            FROM daysmart_class_registrations
            WHERE customer_id IS NOT NULL
              AND (
                (source_type = 'event_registration' AND lower(coalesce(event_name, '')) LIKE '%free trial class%')
                OR (source_type = 'registration' AND team_or_event_id IN ({team_placeholders}))
              )
              AND coalesce(event_start, created_at, '') >= ?
            ORDER BY customer_id ASC
            """,
            (*sorted(ADULT_FREE_TRIAL_TEAM_IDS), cutoff),
        ).fetchall()
        customer_ids = [
            customer_id
            for row in rows
            if (customer_id := _as_int(row["customer_id"])) is not None
        ]

    client = _daysmart_client()
    now_iso = _cache_now_iso()
    refreshed = 0
    spenders = 0
    with get_conn(db_path) as conn:
        _ensure_spend_cache_table(conn)
        for customer_id in sorted(set(customer_ids)):
            latest_spend_at = _latest_positive_spend(client, customer_id)
            conn.execute(
                """
                INSERT INTO daysmart_spend_cache (customer_id, latest_spend_at, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(customer_id) DO UPDATE SET
                    latest_spend_at = excluded.latest_spend_at,
                    updated_at = excluded.updated_at
                """,
                (customer_id, latest_spend_at.isoformat() if latest_spend_at else None, now_iso),
            )
            refreshed += 1
            if latest_spend_at is not None:
                spenders += 1
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")
    _SPEND_PURCHASES_CACHE = None
    recent_spend_event_stats = _refresh_recent_spend_events_for_historical_trials(
        db_path,
        days_back=days_back,
    )
    return {
        "ok": True,
        "days_back": days_back,
        "customers_refreshed": refreshed,
        "spenders": spenders,
        "recent_spend_events": recent_spend_event_stats,
    }


def refresh_historical_daysmart_trial_pack_cache(
    db_path: str,
    *,
    page_size: int = 200,
    start_at: dt.datetime | None = None,
) -> dict[str, Any]:
    """Backfill pack purchases for every historical DaySmart trial attendee."""
    cutoff = start_at or DAYSMART_TRIAL_HISTORY_START
    team_placeholders = ",".join("?" for _ in ADULT_FREE_TRIAL_TEAM_IDS)
    with get_conn(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT DISTINCT customer_id
            FROM daysmart_class_registrations
            WHERE customer_id IS NOT NULL
              AND coalesce(event_start, created_at, '') >= ?
              AND (
                (source_type = 'event_registration' AND lower(coalesce(event_name, '')) LIKE '%free trial class%')
                OR (source_type = 'registration' AND team_or_event_id IN ({team_placeholders}))
              )
            """,
            (cutoff.isoformat(), *sorted(ADULT_FREE_TRIAL_TEAM_IDS)),
        ).fetchall()
        trial_customer_ids = {
            customer_id
            for row in rows
            if (customer_id := _as_int(row["customer_id"])) is not None
        }
    roster_customers = _load_roster_csv_customers(
        window_start=cutoff.date().isoformat(),
        window_end_exclusive=(dt.date.today() + dt.timedelta(days=1)).isoformat(),
    )
    trial_customer_ids.update(roster_customers)

    if not trial_customer_ids:
        return {
            "ok": True,
            "customers_in_scope": 0,
            "invoice_pages_scanned": 0,
            "invoice_items_seen": 0,
            "pack_buyers": 0,
        }

    client = _daysmart_client()
    found_packs: dict[int, str] = {}
    pages_scanned = 0
    invoice_items_seen = 0
    for product_id in sorted(PACK_PRODUCT_IDS):
        page = 1
        while True:
            rows, last_page = client.list_invoice_items(
                page_number=page,
                page_size=page_size,
                filters={"product_id": product_id},
                sort="-date",
            )
            pages_scanned += 1
            invoice_items_seen += len(rows)
            page_dates: list[dt.datetime] = []
            for row in rows:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                item_dt = _parse_ts(
                    attrs.get("date") or attrs.get("created_gmt") or attrs.get("created_at"),
                    naive_tz=LOCAL_TZ,
                )
                if item_dt is not None:
                    page_dates.append(item_dt)
                    if item_dt < cutoff:
                        continue
                customer_id = _as_int(attrs.get("customer_id"))
                if customer_id not in trial_customer_ids or customer_id in found_packs:
                    continue
                quantity = _as_int(attrs.get("quantity")) or 0
                price_value = _money_to_float(attrs.get("price"))
                if (
                    price_value <= 0
                    or quantity <= 1
                    or _as_int(attrs.get("parent_invoice_item_id"))
                    or _as_int(attrs.get("reversed_item_id"))
                ):
                    continue
                pack_name = _purchase_pack_name(product_id, quantity)
                if pack_name:
                    found_packs[customer_id] = pack_name
            if page >= last_page:
                break
            if page_dates and max(page_dates) < cutoff:
                break
            page += 1

    now_iso = _cache_now_iso()
    with get_conn(db_path) as conn:
        for customer_id in sorted(trial_customer_ids):
            pack_name = found_packs.get(customer_id)
            conn.execute(
                """
                INSERT INTO daysmart_pack_cache (customer_id, pack_name, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(customer_id) DO UPDATE SET
                    pack_name = excluded.pack_name,
                    updated_at = excluded.updated_at
                """,
                (customer_id, pack_name, now_iso),
            )
            _PACK_CACHE[customer_id] = (time.time(), pack_name)
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")
    return {
        "ok": True,
        "customers_in_scope": len(trial_customer_ids),
        "invoice_pages_scanned": pages_scanned,
        "invoice_items_seen": invoice_items_seen,
        "pack_buyers": len(found_packs),
    }


def _load_cached_pack_map(conn: Any, customer_ids: set[int]) -> dict[int, str]:
    pack_map: dict[int, str] = {}
    for customer_id in sorted(customer_ids):
        cached = _PACK_CACHE.get(customer_id)
        if cached is not None and cached[1]:
            pack_map[customer_id] = cached[1]
            continue
        row = conn.execute(
            "SELECT pack_name FROM daysmart_pack_cache WHERE customer_id = ?",
            (customer_id,),
        ).fetchone()
        if row is not None and row["pack_name"]:
            pack_map[customer_id] = row["pack_name"]
            _PACK_CACHE[customer_id] = (time.time(), row["pack_name"])
    return pack_map


@lru_cache(maxsize=1)
def _daysmart_client() -> DaysmartClient:
    settings = get_settings()
    return DaysmartClient(
        client_id=settings.daysmart_api_client_id,
        client_secret=settings.daysmart_api_secret,
        base_url=settings.daysmart_base_url,
    )


def _load_event_window(client: DaysmartClient, event_id: int, registration: dict[str, Any], cache: dict[int, tuple[dt.datetime, dt.datetime]]) -> tuple[dt.datetime, dt.datetime] | None:
    cached = cache.get(event_id)
    if cached is not None:
        return cached
    try:
        payload = client.get_event(event_id)
        attrs = payload.get("attributes") if isinstance(payload.get("attributes"), dict) else {}
        starts_at = _parse_ts(attrs.get("start") or attrs.get("start_gmt"), naive_tz=LOCAL_TZ)
        ends_at = _parse_ts(attrs.get("end") or attrs.get("end_gmt"), naive_tz=LOCAL_TZ)
        if starts_at is not None and ends_at is not None:
            cache[event_id] = (starts_at, ends_at)
            return cache[event_id]
    except Exception:
        pass

    start_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
    if start_dt is None:
        return None
    end_dt = start_dt + dt.timedelta(hours=2)
    cache[event_id] = (start_dt, end_dt)
    return cache[event_id]


def _strip_html(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()


def _serialize_checkin_lookup(lookup: dict[int, list[dt.datetime]]) -> str:
    payload = {
        str(customer_id): [visit.astimezone(dt.timezone.utc).isoformat() for visit in visits]
        for customer_id, visits in lookup.items()
    }
    return json.dumps(payload)


def _store_admin_checkin_lookup(
    conn: sqlite3.Connection,
    day_key: str,
    lookup: dict[int, list[dt.datetime]],
    meta: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO daysmart_admin_checkin_cache (cache_date, lookup_json, meta_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_date) DO UPDATE SET
            lookup_json = excluded.lookup_json,
            meta_json = excluded.meta_json,
            updated_at = excluded.updated_at
        """,
        (day_key, _serialize_checkin_lookup(lookup), json.dumps(meta), _cache_now_iso()),
    )
    _ADMIN_CHECKIN_CACHE[day_key] = (lookup, meta)


def _deserialize_checkin_lookup(payload_json: str | None) -> dict[int, list[dt.datetime]]:
    payload = _json_loads(payload_json, {})
    lookup: dict[int, list[dt.datetime]] = {}
    if not isinstance(payload, dict):
        return lookup
    for customer_id, values in payload.items():
        try:
            customer_id_int = int(customer_id)
        except (TypeError, ValueError):
            continue
        visits: list[dt.datetime] = []
        if isinstance(values, list):
            for value in values:
                parsed = _parse_ts(str(value), naive_tz=dt.timezone.utc)
                if parsed is not None:
                    visits.append(parsed.astimezone(LOCAL_TZ))
        if visits:
            visits.sort()
            lookup[customer_id_int] = visits
    return lookup


def _admin_credentials() -> tuple[str, str, str] | None:
    company = os.getenv("DAYSMART_COMPANY", "qbksports").strip() or "qbksports"
    username = os.getenv("DAYSMART_USERNAME", "").strip()
    password = os.getenv("DAYSMART_PASSWORD", "").strip()
    if not username or not password:
        return None
    return company, username, password


def _open_admin_session() -> tuple[requests.Session | None, dict[str, Any]]:
    credentials = _admin_credentials()
    if credentials is None:
        return None, {"source": "missing_admin_credentials", "entries": 0}
    company, username, password = credentials
    session = requests.Session()
    session.headers.update({"User-Agent": "QBKAdultKPIDashboard/1.0"})
    try:
        login_page = session.get(ADMIN_LOGIN_URL, timeout=30)
        login_page.raise_for_status()
        login_response = session.post(
            ADMIN_LOGIN_VALIDATE_URL,
            data={
                "_method": "POST",
                "company_code": company,
                "username": username,
                "password": password,
            },
            headers={
                "X-Requested-With": "XMLHttpRequest",
                "Referer": ADMIN_LOGIN_URL,
            },
            timeout=30,
        )
        login_response.raise_for_status()
        login_payload = login_response.json()
    except Exception as exc:
        session.close()
        return None, {"source": "admin_login_error", "entries": 0, "error": str(exc)[:200]}
    if login_payload.get("success") != "Login Successful":
        session.close()
        return None, {"source": "admin_login_failed", "entries": 0}
    return session, {"source": "admin_login", "entries": 0}


def _parse_admin_customer_checkin_datetime(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    cleaned = value.strip().replace("\\/", "/")
    for fmt in ("%m/%d/%Y %I:%M%p", "%m/%d/%Y %I:%M %p"):
        try:
            return dt.datetime.strptime(cleaned, fmt).replace(tzinfo=LOCAL_TZ)
        except ValueError:
            continue
    return _parse_ts(cleaned, naive_tz=LOCAL_TZ)


def _load_admin_customer_checkins_for_dates(
    customer_ids: set[int],
    target_dates: set[str],
) -> tuple[dict[str, dict[int, list[dt.datetime]]], dict[str, Any]]:
    if not customer_ids or not target_dates:
        return {}, {"source": "admin_customer_checkins", "entries": 0, "customers": 0, "dates": 0}
    session, login_meta = _open_admin_session()
    if session is None:
        return {}, {**login_meta, "dates": len(target_dates), "customers": len(customer_ids)}

    credentials = _admin_credentials()
    company = credentials[0] if credentials is not None else "qbksports"
    by_date: dict[str, dict[int, list[dt.datetime]]] = {date_key: {} for date_key in target_dates}
    customers_queried = 0
    customers_failed = 0
    try:
        for customer_id in sorted(customer_ids):
            customers_queried += 1
            url = ADMIN_CUSTOMER_CHECKINS_URL.format(customer_id=customer_id, company=company)
            try:
                response = session.get(
                    url,
                    headers={
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Referer": _daysmart_account_url(customer_id) or ADMIN_LOGIN_URL,
                    },
                    timeout=30,
                )
                response.raise_for_status()
                payload = response.json()
            except Exception:
                customers_failed += 1
                continue
            data = payload.get("data") if isinstance(payload, dict) else {}
            checkins = data.get("checkins") if isinstance(data, dict) else []
            if not isinstance(checkins, list):
                continue
            for checkin in checkins:
                if not isinstance(checkin, dict):
                    continue
                visit_dt = _parse_admin_customer_checkin_datetime(checkin.get("checkinDatetime"))
                if visit_dt is None:
                    continue
                day_key = visit_dt.date().isoformat()
                if day_key not in target_dates:
                    continue
                by_date.setdefault(day_key, {}).setdefault(customer_id, []).append(visit_dt)
    finally:
        session.close()

    for lookup in by_date.values():
        for visits in lookup.values():
            visits.sort()
    entries = sum(len(visits) for lookup in by_date.values() for visits in lookup.values())
    return by_date, {
        "source": "admin_customer_checkins",
        "entries": entries,
        "customers": len(customer_ids),
        "customers_queried": customers_queried,
        "customers_failed": customers_failed,
        "dates": len(target_dates),
        "used_as_primary": customers_failed == 0,
    }


def _targeted_checkin_meta_for_date(
    day_key: str,
    lookup: dict[int, list[dt.datetime]],
    base_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "source": base_meta.get("source", "admin_customer_checkins"),
        "date": day_key,
        "entries": sum(len(visits) for visits in lookup.values()),
        "customers": len(lookup),
        "customers_queried": base_meta.get("customers_queried", 0),
        "customers_failed": base_meta.get("customers_failed", 0),
        "used_as_primary": base_meta.get("used_as_primary", False),
    }


def _should_use_targeted_customer_checkins(customer_ids_by_date: dict[str, set[int]]) -> bool:
    return False


def _load_admin_location_checkins(
    target_date: dt.date,
    *,
    conn: Any | None = None,
    allow_live: bool = True,
    force_live: bool = False,
) -> tuple[dict[int, list[dt.datetime]], dict[str, Any]]:
    cache_key = target_date.isoformat()
    cached = _ADMIN_CHECKIN_CACHE.get(cache_key)
    now_ts = time.time()
    if cached and not force_live and now_ts - cached[0] <= CHECKIN_CACHE_TTL_SECONDS:
        return cached[1], cached[2]

    if conn is not None and not force_live:
        row = conn.execute(
            "SELECT lookup_json, meta_json FROM daysmart_admin_checkin_cache WHERE cache_date = ?",
            (cache_key,),
        ).fetchone()
        if row is not None:
            lookup = _deserialize_checkin_lookup(row["lookup_json"])
            meta = _json_loads(row["meta_json"], {})
            _ADMIN_CHECKIN_CACHE[cache_key] = (now_ts, lookup, meta)
            return lookup, meta

    if not allow_live:
        meta = {"source": "cache_miss", "date": target_date.isoformat(), "entries": 0}
        return {}, meta

    credentials = _admin_credentials()
    if credentials is None:
        meta = {"source": "missing_admin_credentials", "date": target_date.isoformat(), "entries": 0}
        _ADMIN_CHECKIN_CACHE[cache_key] = (now_ts, {}, meta)
        return {}, meta
    company, _username, _password = credentials

    selected_display = target_date.strftime("%m/%d/%Y")
    payload = {
        "_method": "POST",
        "facility_ids[]": ["1"],
        "membership_ids[]": ["0"],
        "custom_field_id": "0",
        "start_date": selected_display,
        "end_date": selected_display,
        "do_search": "1",
    }
    session, login_meta = _open_admin_session()
    if session is None:
        meta = {**login_meta, "date": target_date.isoformat()}
        _ADMIN_CHECKIN_CACHE[cache_key] = (now_ts, {}, meta)
        return {}, meta
    try:
        report_response = session.post(
            ADMIN_LOCATION_CHECKIN_REPORT_URL.format(company=company),
            data=payload,
            timeout=30,
        )
        report_response.raise_for_status()
        html_text = report_response.text
    finally:
        session.close()

    table_match = REPORT_TABLE_RE.search(html_text)
    if not table_match:
        meta = {"source": "admin_report_missing_table", "date": target_date.isoformat(), "entries": 0}
        _ADMIN_CHECKIN_CACHE[cache_key] = (now_ts, {}, meta)
        return {}, meta

    lookup: dict[int, list[dt.datetime]] = {}
    tbody = table_match.group("tbody")
    for row_match in REPORT_ROW_RE.finditer(tbody):
        cells = [cell_match.group("cell") for cell_match in REPORT_CELL_RE.finditer(row_match.group("row"))]
        if len(cells) < 5:
            continue
        customer_id = _strip_html(cells[1])
        visit_display = _strip_html(cells[4])
        try:
            customer_id_int = int(customer_id)
        except (TypeError, ValueError):
            continue
        try:
            visit_dt = dt.datetime.strptime(visit_display, "%m/%d/%Y %I:%M%p").replace(tzinfo=LOCAL_TZ)
        except ValueError:
            continue
        lookup.setdefault(customer_id_int, []).append(visit_dt)

    for visits in lookup.values():
        visits.sort()
    meta = {
        "source": "admin_location_report",
        "date": target_date.isoformat(),
        "entries": sum(len(visits) for visits in lookup.values()),
        "customers": len(lookup),
    }
    if conn is not None:
        try:
            conn.execute(
                """
                INSERT INTO daysmart_admin_checkin_cache (cache_date, lookup_json, meta_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_date) DO UPDATE SET
                    lookup_json = excluded.lookup_json,
                    meta_json = excluded.meta_json,
                    updated_at = excluded.updated_at
                """,
                (cache_key, _serialize_checkin_lookup(lookup), json.dumps(meta), _cache_now_iso()),
            )
        except sqlite3.OperationalError as exc:
            if "database is locked" not in str(exc).lower():
                raise
            meta = {**meta, "cache_write_skipped": "database_locked"}
    _ADMIN_CHECKIN_CACHE[cache_key] = (now_ts, lookup, meta)
    return lookup, meta


def refresh_adult_kpi_daysmart_detail_cache(
    db_path: str,
    *,
    adult_inbox_id: int,
    days: int = 7,
    window: str | None = "this_year",
    include_checkins: bool = True,
    include_packs: bool = True,
) -> dict[str, Any]:
    now_utc = dt.datetime.now(dt.timezone.utc)
    window_config = _resolve_window(now_utc=now_utc, days=days, window=window)
    window_end_exclusive = _window_end_exclusive(window_config)
    with get_conn(db_path) as conn:
        lead_rows = conn.execute(
            """
            SELECT id, inbox_id, contact_name, contact_number, started_at, closed_at, last_message_at, raw_json
            FROM conversations
            WHERE inbox_id = ?
              AND coalesce(started_at, '') >= ?
              AND coalesce(started_at, '') < ?
            ORDER BY coalesce(started_at, '') DESC, id DESC
            """,
            (adult_inbox_id, window_config["start_date"], window_end_exclusive),
        ).fetchall()

        matched_rows: list[dict[str, Any]] = []
        customer_ids: set[int] = set()
        for row in lead_rows:
            lead = dict(row)
            customer = _find_adult_daysmart_customer(conn, lead)
            lead["daysmart_customer"] = customer
            matched_rows.append(lead)
            if customer is not None:
                customer_ids.add(int(customer["customer_id"]))

        registration_map = _load_registration_map(
            conn,
            customer_ids,
            client=None,
            allow_live_fallback=False,
        )

    relevant_dates: set[str] = set()
    customer_ids_by_date: dict[str, set[int]] = {}
    for lead in matched_rows:
        started_at = _parse_ts(lead.get("started_at"))
        customer = lead.get("daysmart_customer")
        customer_id = int(customer["customer_id"]) if customer is not None else None
        registrations = registration_map.get(customer_id or -1, [])
        for registration in _filter_registrations_for_lead(registrations, lead_started_at=started_at):
            event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
            if event_dt is not None:
                day_key = event_dt.astimezone(LOCAL_TZ).date().isoformat()
                relevant_dates.add(day_key)
                if customer_id is not None:
                    customer_ids_by_date.setdefault(day_key, set()).add(customer_id)

    refreshed_reports: list[dict[str, Any]] = []
    if include_checkins:
        targeted_by_date: dict[str, dict[int, list[dt.datetime]]] = {}
        targeted_meta: dict[str, Any] = {}
        if _should_use_targeted_customer_checkins(customer_ids_by_date):
            targeted_customer_ids = set().union(*customer_ids_by_date.values())
            targeted_by_date, targeted_meta = _load_admin_customer_checkins_for_dates(
                targeted_customer_ids,
                set(customer_ids_by_date),
            )
        with get_conn(db_path) as conn:
            for day_key in sorted(relevant_dates):
                if targeted_meta.get("used_as_primary"):
                    lookup = targeted_by_date.get(day_key, {})
                    meta = _targeted_checkin_meta_for_date(day_key, lookup, targeted_meta)
                    _store_admin_checkin_lookup(conn, day_key, lookup, meta)
                else:
                    _ADMIN_CHECKIN_CACHE.pop(day_key, None)
                    _, meta = _load_admin_location_checkins(
                        dt.date.fromisoformat(day_key),
                        conn=conn,
                        allow_live=True,
                        force_live=True,
                    )
                refreshed_reports.append(meta)

    pack_map: dict[int, str] = {}
    if include_packs and customer_ids:
        client = _daysmart_client()
        with get_conn(db_path) as conn:
            pack_map = _load_pack_map(client, customer_ids, conn=conn)

    with get_conn(db_path) as conn:
        _clear_dashboard_cache_rows(conn)

    return {
        "window": window_config["label"],
        "matched_leads": len(customer_ids),
        "checkin_dates_refreshed": len(refreshed_reports) if include_checkins else 0,
        "checkin_entries": sum(int(item.get("entries") or 0) for item in refreshed_reports),
        "pack_customers_refreshed": len(customer_ids) if include_packs else 0,
        "pack_buyers": len(pack_map),
        "reports": refreshed_reports,
    }


def _registration_checked_in(
    registration: dict[str, Any],
    *,
    checkins_by_date: dict[str, dict[int, list[dt.datetime]]],
    client: DaysmartClient,
    event_cache: dict[int, tuple[dt.datetime, dt.datetime]],
) -> tuple[bool, dt.datetime | None]:
    source_type = str(registration.get("source_type") or "")
    event_id_raw = registration.get("team_or_event_id")
    try:
        event_id = int(event_id_raw)
    except (TypeError, ValueError):
        event_id = 0
    customer_id = int(registration["customer_id"])
    # Plain registrations point at a team id, not a specific event id.
    # If we cache those by team id, one lead can incorrectly reuse another
    # lead's inferred class date for the same recurring free-trial team.
    window = None
    if event_id and source_type == "event_registration":
        window = _load_event_window(client, event_id, registration, event_cache)
    if window is None:
        start_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        if start_dt is None:
            return False, None
        end_dt = start_dt + dt.timedelta(hours=2)
    else:
        start_dt, end_dt = window
    local_start = start_dt.astimezone(LOCAL_TZ)
    local_end = end_dt.astimezone(LOCAL_TZ)
    day_key = local_start.date().isoformat()
    window_start = local_start - dt.timedelta(hours=CHECKIN_MATCH_WINDOW_HOURS)
    window_end = local_end + dt.timedelta(hours=CHECKIN_MATCH_WINDOW_HOURS)
    for visit_dt in checkins_by_date.get(day_key, {}).get(customer_id, []):
        if window_start <= visit_dt <= window_end:
            return True, visit_dt.astimezone(dt.timezone.utc)
    return False, None


def _registration_checked_in_from_cached_event(
    registration: dict[str, Any],
    *,
    checkins_by_date: dict[str, dict[int, list[dt.datetime]]],
) -> tuple[bool, dt.datetime | None]:
    customer_id = _as_int(registration.get("customer_id"))
    if customer_id is None:
        return False, None
    start_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
    if start_dt is None:
        return False, None
    local_start = start_dt.astimezone(LOCAL_TZ)
    local_end = local_start + dt.timedelta(hours=2)
    day_key = local_start.date().isoformat()
    window_start = local_start - dt.timedelta(hours=CHECKIN_MATCH_WINDOW_HOURS)
    window_end = local_end + dt.timedelta(hours=CHECKIN_MATCH_WINDOW_HOURS)
    for visit_dt in checkins_by_date.get(day_key, {}).get(customer_id, []):
        if window_start <= visit_dt <= window_end:
            return True, visit_dt.astimezone(dt.timezone.utc)
    return False, None


def _ensure_manual_trial_checkins_table(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daysmart_manual_trial_checkins (
            customer_id INTEGER NOT NULL,
            event_date TEXT NOT NULL,
            checkin_at TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (customer_id, event_date)
        )
        """
    )


def _merge_manual_trial_checkins(
    conn: Any,
    checkins_by_date: dict[str, dict[int, list[dt.datetime]]],
    relevant_dates: set[str],
) -> int:
    if not relevant_dates:
        return 0
    _ensure_manual_trial_checkins_table(conn)
    placeholders = ",".join("?" for _ in relevant_dates)
    rows = conn.execute(
        f"""
        SELECT customer_id, event_date, checkin_at
        FROM daysmart_manual_trial_checkins
        WHERE event_date IN ({placeholders})
        """,
        tuple(sorted(relevant_dates)),
    ).fetchall()
    merged = 0
    for row in rows:
        customer_id = _as_int(row["customer_id"])
        day_key = str(row["event_date"] or "")
        checkin_dt = _parse_ts(row["checkin_at"], naive_tz=LOCAL_TZ)
        if customer_id is None or not day_key or checkin_dt is None:
            continue
        visits = checkins_by_date.setdefault(day_key, {}).setdefault(customer_id, [])
        visits.append(checkin_dt)
        visits.sort()
        merged += 1
    return merged


def _display_registration(registration: dict[str, Any] | None) -> str:
    if not registration:
        return ""
    name = _clean_text(registration.get("event_name"))
    event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
    label = _format_local(event_dt) if event_dt else ""
    if name and label:
        return f"{name} - {label}"
    return name or label


def _filter_registrations_for_lead(
    registrations: list[dict[str, Any]],
    *,
    lead_started_at: dt.datetime | None,
) -> list[dict[str, Any]]:
    if lead_started_at is None:
        return list(registrations)
    filtered: list[dict[str, Any]] = []
    lower_bound = lead_started_at - dt.timedelta(days=1)
    for registration in registrations:
        event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        if event_dt is None or event_dt >= lower_bound:
            filtered.append(registration)
    return filtered


def _is_mixed_inbox_period(lead_started_at: dt.datetime | None) -> bool:
    if lead_started_at is None:
        return False
    return lead_started_at.astimezone(dt.timezone.utc) < ADULT_INBOX_YOUTH_MIXED_CUTOFF


def _conversation_text(conn: Any, conversation_id: int) -> str:
    rows = conn.execute(
        """
        SELECT body
        FROM messages
        WHERE conversation_id = ?
          AND coalesce(body, '') != ''
        ORDER BY coalesce(created_at, sent_at, received_at, '') ASC, id ASC
        LIMIT 12
        """,
        (conversation_id,),
    ).fetchall()
    return "\n".join(_clean_text(row["body"]) for row in rows if row["body"])


def _is_likely_youth_lead_from_text(message_text: str) -> bool:
    if not message_text.strip():
        return False
    return YOUTH_LEAD_TEXT_RE.search(message_text) is not None


def _lead_status(
    *,
    closed_at: dt.datetime | None,
    has_scheduled: bool,
    has_checked_in: bool,
    has_no_show: bool,
    has_membership: bool,
    last_interaction_at: dt.datetime | None,
    now: dt.datetime,
) -> str:
    if has_membership:
        return "Membership purchased"
    if has_checked_in:
        return "Checked in"
    if has_no_show:
        return "No-show"
    if has_scheduled:
        return "Scheduled"
    if closed_at is not None:
        return "Lost"
    if last_interaction_at is not None and last_interaction_at <= now - dt.timedelta(days=2):
        return "Needs follow-up"
    return "New"


def _resolve_window(*, now_utc: dt.datetime, days: int = 7, window: str | None = None) -> dict[str, Any]:
    if window == "all_time":
        return {
            "mode": "all_time",
            "days": None,
            "start_date": dt.date(2025, 1, 1).isoformat(),
            "end_date": now_utc.date().isoformat(),
            "label": "All Time (2025-2026)",
            "summary_subtext": "2025-2026 cohort",
        }

    if window == "last_year":
        year = now_utc.year - 1
        return {
            "mode": "last_year",
            "days": None,
            "start_date": dt.date(year, 1, 1).isoformat(),
            "end_date": dt.date(year, 12, 31).isoformat(),
            "label": f"Last Year ({year})",
            "summary_subtext": f"{year} cohort",
        }

    if window == "this_year":
        start_date = dt.date(now_utc.year, 1, 1)
        return {
            "mode": "this_year",
            "days": None,
            "start_date": start_date.isoformat(),
            "end_date": now_utc.date().isoformat(),
            "label": f"This Year ({now_utc.year})",
            "summary_subtext": f"{now_utc.year} cohort",
        }

    days = max(1, min(days, 90))
    start_date = now_utc.date() - dt.timedelta(days=days)
    return {
        "mode": "rolling_days",
        "days": days,
        "start_date": start_date.isoformat(),
        "end_date": now_utc.date().isoformat(),
        "label": f"Last {days} Days",
        "summary_subtext": f"{days} day cohort",
    }


def _resolve_daysmart_trial_window(*, now_utc: dt.datetime, days: int = 7, window: str | None = None) -> dict[str, Any]:
    window_config = _resolve_window(now_utc=now_utc, days=days, window=window)
    if window == "all_time":
        window_config = dict(window_config)
        window_config["start_date"] = DAYSMART_TRIAL_HISTORY_START.date().isoformat()
        window_config["label"] = "All Time"
        window_config["summary_subtext"] = "historical cohort"
    return window_config


def _window_end_exclusive(window_config: dict[str, Any]) -> str:
    end_date = dt.date.fromisoformat(str(window_config["end_date"]))
    return (end_date + dt.timedelta(days=1)).isoformat()


def _period_start(target_date: dt.date, granularity: str) -> dt.date:
    if granularity == "year":
        return dt.date(target_date.year, 1, 1)
    if granularity == "quarter":
        quarter_start_month = ((target_date.month - 1) // 3) * 3 + 1
        return dt.date(target_date.year, quarter_start_month, 1)
    if granularity == "month":
        return target_date.replace(day=1)
    return target_date - dt.timedelta(days=target_date.weekday())


def _next_period_start(target_date: dt.date, granularity: str) -> dt.date:
    if granularity == "year":
        return dt.date(target_date.year + 1, 1, 1)
    if granularity == "quarter":
        next_month = target_date.month + 3
        if next_month > 12:
            return dt.date(target_date.year + 1, next_month - 12, 1)
        return dt.date(target_date.year, next_month, 1)
    if granularity == "month":
        if target_date.month == 12:
            return dt.date(target_date.year + 1, 1, 1)
        return dt.date(target_date.year, target_date.month + 1, 1)
    return target_date + dt.timedelta(days=7)


def _format_period_label(period_start: dt.date, granularity: str) -> str:
    if granularity == "year":
        return str(period_start.year)
    if granularity == "quarter":
        return f"Q{((period_start.month - 1) // 3) + 1} {period_start.year}"
    if granularity == "month":
        return period_start.strftime("%b %Y")
    return f"Week of {period_start.strftime('%-m/%-d/%y')}"


def _format_phone_display(*values: Any) -> str:
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        digits = "".join(ch for ch in value if ch.isdigit())
        if len(digits) >= 10:
            last = digits[-10:]
            return f"({last[:3]}) {last[3:6]}-{last[6:]}"
        return value.strip()
    return "--"


def _load_free_trial_event_registrations(
    conn: Any,
    *,
    window_start: str,
    window_end_exclusive: str,
    specific_event_only: bool = False,
) -> list[dict[str, Any]]:
    team_placeholders = ",".join("?" for _ in ADULT_FREE_TRIAL_TEAM_IDS)
    source_filter = (
        "(r.source_type = 'event_registration' AND lower(coalesce(r.event_name, '')) LIKE '%free trial class%')"
        if specific_event_only
        else f"""
            (r.source_type = 'event_registration' AND lower(coalesce(r.event_name, '')) LIKE '%free trial class%')
            OR (r.source_type = 'registration' AND r.team_or_event_id IN ({team_placeholders}))
        """
    )
    source_params = () if specific_event_only else tuple(sorted(ADULT_FREE_TRIAL_TEAM_IDS))
    rows = conn.execute(
        f"""
        SELECT
            r.source_type,
            r.registration_id,
            r.customer_id,
            r.team_or_event_id,
            r.event_name,
            r.event_start,
            r.created_at,
            c.full_name,
            c.email,
            c.phone_day,
            c.phone_mobile,
            c.normalized_phone_day,
            c.normalized_phone_mobile
        FROM daysmart_class_registrations r
        LEFT JOIN daysmart_customers c ON c.customer_id = r.customer_id
        WHERE ({source_filter})
          AND coalesce(r.event_start, r.created_at, '') >= ?
          AND coalesce(r.event_start, r.created_at, '') < ?
        ORDER BY coalesce(r.event_start, r.created_at, '') DESC, r.registration_id DESC
        """,
        (*source_params, window_start, window_end_exclusive),
    ).fetchall()

    deduped: dict[tuple[int, int | None, str], dict[str, Any]] = {}
    for row in rows:
        registration = dict(row)
        customer_id = _as_int(registration.get("customer_id"))
        if customer_id is None:
            continue
        event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        event_key = event_dt.isoformat() if event_dt is not None else str(registration.get("event_start") or "")
        key = (
            customer_id,
            _as_int(registration.get("team_or_event_id")) or _as_int(registration.get("registration_id")),
            event_key,
        )
        registration["event_name"] = _normalize_daysmart_label(registration.get("event_name"))
        deduped[key] = registration
    return list(deduped.values())


def _load_roster_csv_customers(
    *,
    window_start: str,
    window_end_exclusive: str,
) -> dict[int, dict[str, Any]]:
    start_year = dt.date.fromisoformat(window_start[:10]).year
    end_year = (dt.date.fromisoformat(window_end_exclusive[:10]) - dt.timedelta(days=1)).year
    customers: dict[int, dict[str, Any]] = {}
    for roster_year, path in FREE_TRIAL_ROSTER_CSVS.items():
        if roster_year < start_year or roster_year > end_year or not path.exists():
            continue
        with path.open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                customer_id = _as_int(row.get("CID"))
                if customer_id is None:
                    continue
                full_name = " ".join(
                    part.strip()
                    for part in (str(row.get("First Name") or ""), str(row.get("Last Name") or ""))
                    if part.strip()
                )
                customers[customer_id] = {
                    "customer_id": customer_id,
                    "roster_year": roster_year,
                    "full_name": full_name or f"Customer {customer_id}",
                    "email": _normalize_email(row.get("Email")),
                    "phone_day": row.get("Day PH"),
                    "phone_mobile": row.get("Mobile PH"),
                    "normalized_phone_day": _normalize_phone(row.get("Day PH")),
                    "normalized_phone_mobile": _normalize_phone(row.get("Mobile PH")),
                    "raw_json": row,
                }
    return customers


def _free_trial_event_candidates(registrations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: dict[tuple[str, int | None], dict[str, Any]] = {}
    for registration in registrations:
        event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        if event_dt is None:
            continue
        local_start = event_dt.astimezone(LOCAL_TZ)
        team_or_event_id = _as_int(registration.get("team_or_event_id"))
        key = (local_start.replace(second=0, microsecond=0).isoformat(), team_or_event_id)
        existing = events.get(key)
        if existing is None or (not existing.get("event_name") and registration.get("event_name")):
            events[key] = {
                "event_dt": event_dt,
                "event_name": registration.get("event_name") or "Free Trial Class",
                "team_or_event_id": team_or_event_id,
            }
    return sorted(events.values(), key=lambda item: item["event_dt"])


def _csv_roster_attended_registrations(
    roster_customers: dict[int, dict[str, Any]],
    registrations: list[dict[str, Any]],
    *,
    checkins_by_date: dict[str, dict[int, list[dt.datetime]]],
    window_start: str,
    window_end_exclusive: str,
) -> list[tuple[dict[str, Any], dt.datetime]]:
    if not roster_customers or not checkins_by_date:
        return []
    window_start_dt = _parse_ts(window_start, naive_tz=LOCAL_TZ)
    window_end_dt = _parse_ts(window_end_exclusive, naive_tz=LOCAL_TZ)
    events_by_year: dict[int, list[dict[str, Any]]] = {}
    for event in _free_trial_event_candidates(registrations):
        event_dt = event["event_dt"]
        if window_start_dt is not None and event_dt < window_start_dt:
            continue
        if window_end_dt is not None and event_dt >= window_end_dt:
            continue
        events_by_year.setdefault(event_dt.astimezone(LOCAL_TZ).year, []).append(event)

    attended: list[tuple[dict[str, Any], dt.datetime]] = []
    for customer_id, customer in roster_customers.items():
        events_by_day: dict[str, list[dict[str, Any]]] = {}
        for event in events_by_year.get(int(customer["roster_year"]), []):
            local_start = event["event_dt"].astimezone(LOCAL_TZ)
            events_by_day.setdefault(local_start.date().isoformat(), []).append(event)
        for day_key, visits in checkins_by_date.items():
            day_events = events_by_day.get(day_key)
            if not day_events:
                continue
            for visit_dt in visits.get(customer_id, []):
                matched_event = None
                matched_distance = None
                for event in day_events:
                    local_start = event["event_dt"].astimezone(LOCAL_TZ)
                    local_end = local_start + dt.timedelta(hours=2)
                    window_start_match = local_start - dt.timedelta(hours=CHECKIN_MATCH_WINDOW_HOURS)
                    window_end_match = local_end + dt.timedelta(hours=CHECKIN_MATCH_WINDOW_HOURS)
                    if not (window_start_match <= visit_dt <= window_end_match):
                        continue
                    distance = abs((visit_dt - local_start).total_seconds())
                    if matched_distance is None or distance < matched_distance:
                        matched_event = event
                        matched_distance = distance
                if matched_event is None:
                    continue
                local_start = matched_event["event_dt"].astimezone(LOCAL_TZ)
                matched_at = visit_dt.astimezone(dt.timezone.utc)
                synthetic_registration = {
                    "source_type": "csv_roster",
                    "registration_id": -int(f"{customer_id}{local_start:%Y%m%d%H%M}"),
                    "customer_id": customer_id,
                    "team_or_event_id": matched_event.get("team_or_event_id"),
                    "event_name": matched_event.get("event_name") or "Free Trial Class",
                    "event_start": matched_event["event_dt"].isoformat(),
                    "created_at": matched_event["event_dt"].isoformat(),
                    "full_name": customer.get("full_name"),
                    "email": customer.get("email"),
                    "phone_day": customer.get("phone_day"),
                    "phone_mobile": customer.get("phone_mobile"),
                    "normalized_phone_day": customer.get("normalized_phone_day"),
                    "normalized_phone_mobile": customer.get("normalized_phone_mobile"),
                }
                attended.append((synthetic_registration, matched_at))
    return attended


def refresh_daysmart_trial_attendee_source(
    db_path: str,
    *,
    days: int = 7,
    window: str | None = None,
    page_size: int = 200,
) -> dict[str, Any]:
    from .unified import _first_page_at_or_after, _upsert_daysmart_class_registration

    now_utc = dt.datetime.now(dt.timezone.utc)
    window_config = _resolve_daysmart_trial_window(now_utc=now_utc, days=days, window=window)
    client = _daysmart_client()
    event_cache: dict[int, tuple[str | None, str | None]] = {}
    known_event_lookup = _known_free_trial_event_lookup(client)
    pages_scanned = 0
    event_registrations_seen = 0
    free_trial_registrations_upserted = 0
    free_trial_event_ids: set[int] = set()
    with get_conn(db_path) as conn:
        for row in conn.execute(
            """
            SELECT team_or_event_id, event_name, event_start
            FROM daysmart_class_registrations
            WHERE source_type = 'event_registration'
              AND team_or_event_id IS NOT NULL
              AND coalesce(event_name, '') != ''
            """
        ).fetchall():
            event_id = _as_int(row["team_or_event_id"])
            if event_id is not None:
                event_cache[event_id] = (row["event_name"], row["event_start"])

    known_free_trial_event_ids = set(known_event_lookup) | {
        event_id
        for event_id, cached in event_cache.items()
        if "free trial class" in _normalize_daysmart_label(cached[0]).lower()
    }

    first_data, last_page = client.list_event_registrations(page_number=1, page_size=page_size)
    if not first_data:
        last_page = 0
        start_page = 1
        page_cache: dict[int, list[dict[str, Any]]] = {}
    else:
        page_cache = {1: first_data}

        def fetch_page(page_number: int) -> list[dict[str, Any]]:
            if page_number not in page_cache:
                page_cache[page_number] = client.list_event_registrations(
                    page_number=page_number,
                    page_size=page_size,
                )[0]
            return page_cache[page_number]

        # Keep this intentionally wider than the selected UI window. People can
        # register before the date window for a trial class inside it.
        start_page = _first_page_at_or_after(
            fetch_page=fetch_page,
            last_page=last_page,
            cutoff=DAYSMART_TRIAL_HISTORY_START,
        )

    with get_conn(db_path) as conn:
        for page in range(start_page, last_page + 1):
            data = page_cache.get(page)
            if data is None:
                data = client.list_event_registrations(page_number=page, page_size=page_size)[0]
            pages_scanned += 1
            event_registrations_seen += len(data)
            for row in data:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                event_id = _as_int(attrs.get("event_id"))
                if event_id is None:
                    continue
                cached = known_event_lookup.get(event_id) or event_cache.get(event_id)
                if event_id not in known_free_trial_event_ids:
                    continue
                event_name, event_start = cached
                if "free trial class" not in _normalize_daysmart_label(event_name).lower():
                    continue
                _upsert_daysmart_class_registration(
                    db_path,
                    source_type="event_registration",
                    row=row,
                    event_name=event_name,
                    event_start=event_start,
                    conn=conn,
                )
                free_trial_registrations_upserted += 1
                free_trial_event_ids.add(event_id)
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")

    return {
        "ok": True,
        "window": window_config["label"],
        "pages_scanned": pages_scanned,
        "event_registrations_seen": event_registrations_seen,
        "free_trial_event_count": len(free_trial_event_ids),
        "free_trial_registrations_upserted": free_trial_registrations_upserted,
    }


def _event_registration_details_for_refresh(
    client: DaysmartClient,
    event_id: int,
    event_cache: dict[int, tuple[str | None, str | None]],
) -> tuple[str | None, str | None]:
    cached = event_cache.get(event_id)
    if cached is not None:
        return cached
    try:
        event_payload = client.get_event(event_id)
        event_attrs = (
            event_payload.get("attributes")
            if isinstance(event_payload.get("attributes"), dict)
            else {}
        )
        event_name = event_attrs.get("desc") or event_attrs.get("name")
        team_id = _as_int(event_attrs.get("hteam_id"))
        if team_id in ADULT_FREE_TRIAL_TEAM_IDS and not event_name:
            event_name = "Free Trial Class"
        if not event_name and team_id is not None:
            try:
                team_payload = client._get(f"/api/v1/teams/{team_id}")
                team = team_payload.get("data") if isinstance(team_payload, dict) else None
                team_attrs = (
                    team.get("attributes")
                    if isinstance(team, dict) and isinstance(team.get("attributes"), dict)
                    else {}
                )
                event_name = team_attrs.get("name") or event_name
            except Exception:
                pass
        cached = (event_name, event_attrs.get("start") or event_attrs.get("start_gmt"))
    except Exception:
        cached = (None, None)
    event_cache[event_id] = cached
    return cached


def refresh_recent_daysmart_trial_registrations(
    db_path: str,
    *,
    page_size: int = 200,
    max_pages: int = 8,
) -> dict[str, Any]:
    from .unified import _upsert_daysmart_class_registration, _upsert_daysmart_customer

    client = _daysmart_client()
    event_cache: dict[int, tuple[str | None, str | None]] = {}
    known_event_lookup = _known_free_trial_event_lookup(client)
    pages_scanned = 0
    event_registrations_seen = 0
    free_trial_registrations_upserted = 0
    customers_upserted = 0
    targeted_event_registrations_seen = 0
    targeted_free_trial_registrations_upserted = 0
    now_local = dt.datetime.now(LOCAL_TZ)
    recent_event_start = now_local - dt.timedelta(days=45)
    recent_event_end = now_local + dt.timedelta(days=21)
    with get_conn(db_path) as conn:
        for row in conn.execute(
            """
            SELECT team_or_event_id, event_name, event_start
            FROM daysmart_class_registrations
            WHERE source_type = 'event_registration'
              AND team_or_event_id IS NOT NULL
              AND coalesce(event_name, '') != ''
            """
        ).fetchall():
            event_id = _as_int(row["team_or_event_id"])
            if event_id is not None:
                event_cache[event_id] = (row["event_name"], row["event_start"])

    targeted_event_ids: list[int] = []
    for event_id, (_event_name, event_start) in known_event_lookup.items():
        event_dt = _parse_ts(event_start, naive_tz=LOCAL_TZ)
        if event_dt is not None and recent_event_start <= event_dt <= recent_event_end:
            targeted_event_ids.append(event_id)
    targeted_event_ids = sorted(set(targeted_event_ids))

    def upsert_customer_if_needed(conn: Any, customer_id: int | None) -> bool:
        if customer_id is None:
            return False
        existing = conn.execute(
            "SELECT customer_id FROM daysmart_customers WHERE customer_id = ?",
            (customer_id,),
        ).fetchone()
        if existing is not None:
            return False
        try:
            customer_payload = client._get(f"/api/v1/customers/{customer_id}")
            customer = customer_payload.get("data") if isinstance(customer_payload, dict) else None
            if isinstance(customer, dict):
                _upsert_daysmart_customer(db_path, customer, conn=conn)
                return True
        except Exception:
            return False
        return False

    with get_conn(db_path) as conn:
        for event_id in targeted_event_ids:
            event_name, event_start = known_event_lookup[event_id]
            page = 1
            while True:
                data, last_page_for_event = client.list_event_registrations(
                    page_number=page,
                    page_size=page_size,
                    params={"filter[event_id]": event_id},
                )
                targeted_event_registrations_seen += len(data)
                for row in data:
                    attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                    customer_id = _as_int(attrs.get("customer_id"))
                    _upsert_daysmart_class_registration(
                        db_path,
                        source_type="event_registration",
                        row=row,
                        event_name=event_name,
                        event_start=event_start,
                        conn=conn,
                    )
                    targeted_free_trial_registrations_upserted += 1
                    if upsert_customer_if_needed(conn, customer_id):
                        customers_upserted += 1
                if page >= last_page_for_event:
                    break
                page += 1

    first_data, last_page = client.list_event_registrations(page_number=1, page_size=page_size)
    if not first_data:
        return {
            "ok": True,
            "pages_scanned": 0,
            "event_registrations_seen": 0,
            "free_trial_registrations_upserted": 0,
            "targeted_event_count": len(targeted_event_ids),
            "targeted_event_registrations_seen": targeted_event_registrations_seen,
            "targeted_free_trial_registrations_upserted": targeted_free_trial_registrations_upserted,
            "customers_upserted": 0,
        }

    start_page = max(1, last_page - max_pages + 1)
    with get_conn(db_path) as conn:
        for page in range(start_page, last_page + 1):
            data = first_data if page == 1 else client.list_event_registrations(
                page_number=page,
                page_size=page_size,
            )[0]
            pages_scanned += 1
            event_registrations_seen += len(data)
            for row in data:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                event_id = _as_int(attrs.get("event_id"))
                customer_id = _as_int(attrs.get("customer_id"))
                if event_id is None:
                    continue
                event_name, event_start = known_event_lookup.get(event_id) or _event_registration_details_for_refresh(client, event_id, event_cache)
                if "free trial class" not in _normalize_daysmart_label(event_name).lower():
                    continue
                _upsert_daysmart_class_registration(
                    db_path,
                    source_type="event_registration",
                    row=row,
                    event_name=event_name,
                    event_start=event_start,
                    conn=conn,
                )
                free_trial_registrations_upserted += 1
                if upsert_customer_if_needed(conn, customer_id):
                    customers_upserted += 1
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")

    return {
        "ok": True,
        "pages_scanned": pages_scanned,
        "event_registrations_seen": event_registrations_seen,
        "free_trial_registrations_upserted": free_trial_registrations_upserted,
        "targeted_event_count": len(targeted_event_ids),
        "targeted_event_registrations_seen": targeted_event_registrations_seen,
        "targeted_free_trial_registrations_upserted": targeted_free_trial_registrations_upserted,
        "customers_upserted": customers_upserted,
    }


def refresh_historical_known_trial_team_registrations(
    db_path: str,
    *,
    page_size: int = 200,
) -> dict[str, Any]:
    from .unified import _first_page_at_or_after, _upsert_daysmart_class_registration

    client = _daysmart_client()
    first_data, last_page = client.list_registrations(page_number=1, page_size=page_size)
    if not first_data:
        return {"ok": True, "pages_scanned": 0, "registrations_seen": 0, "trial_registrations_upserted": 0}

    page_cache: dict[int, list[dict[str, Any]]] = {1: first_data}

    def fetch_page(page_number: int) -> list[dict[str, Any]]:
        if page_number not in page_cache:
            page_cache[page_number] = client.list_registrations(
                page_number=page_number,
                page_size=page_size,
            )[0]
        return page_cache[page_number]

    start_page = _first_page_at_or_after(
        fetch_page=fetch_page,
        last_page=last_page,
        cutoff=DAYSMART_TRIAL_HISTORY_START,
    )
    pages_scanned = 0
    registrations_seen = 0
    trial_registrations_upserted = 0
    with get_conn(db_path) as conn:
        for page in range(start_page, last_page + 1):
            data = page_cache.get(page)
            if data is None:
                data = client.list_registrations(page_number=page, page_size=page_size)[0]
            pages_scanned += 1
            registrations_seen += len(data)
            for row in data:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                team_id = _as_int(attrs.get("team_id"))
                if team_id not in ADULT_FREE_TRIAL_TEAM_IDS:
                    continue
                _upsert_daysmart_class_registration(
                    db_path,
                    source_type="registration",
                    row=row,
                    conn=conn,
                )
                trial_registrations_upserted += 1
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")

    return {
        "ok": True,
        "pages_scanned": pages_scanned,
        "registrations_seen": registrations_seen,
        "trial_registrations_upserted": trial_registrations_upserted,
    }


def refresh_recent_known_trial_team_registrations(
    db_path: str,
    *,
    page_size: int = 200,
    max_pages: int = 12,
) -> dict[str, Any]:
    from .unified import _upsert_daysmart_class_registration

    client = _daysmart_client()
    first_data, last_page = client.list_registrations(page_number=1, page_size=page_size)
    if not first_data:
        return {"ok": True, "pages_scanned": 0, "registrations_seen": 0, "trial_registrations_upserted": 0}
    start_page = max(1, last_page - max_pages + 1)
    pages_scanned = 0
    registrations_seen = 0
    trial_registrations_upserted = 0
    hydrated = 0
    with get_conn(db_path) as conn:
        for page in range(start_page, last_page + 1):
            data = first_data if page == 1 else client.list_registrations(
                page_number=page,
                page_size=page_size,
            )[0]
            pages_scanned += 1
            registrations_seen += len(data)
            for row in data:
                attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
                team_id = _as_int(attrs.get("team_id"))
                if team_id not in ADULT_FREE_TRIAL_TEAM_IDS:
                    continue
                _upsert_daysmart_class_registration(
                    db_path,
                    source_type="registration",
                    row=row,
                    conn=conn,
                )
                trial_registrations_upserted += 1
    if trial_registrations_upserted:
        with get_conn(db_path) as conn:
            now_utc = dt.datetime.now(dt.timezone.utc)
            window_config = _resolve_daysmart_trial_window(now_utc=now_utc, days=90, window=None)
            regs = _load_free_trial_event_registrations(
                conn,
                window_start=window_config["start_date"],
                window_end_exclusive=_window_end_exclusive(window_config),
            )
        hydrated = _hydrate_known_trial_team_registrations(db_path, regs)
        with get_conn(db_path) as conn:
            _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")
    return {
        "ok": True,
        "pages_scanned": pages_scanned,
        "registrations_seen": registrations_seen,
        "trial_registrations_upserted": trial_registrations_upserted,
        "historical_registrations_hydrated": hydrated,
    }


def refresh_daysmart_trial_checkin_history(
    db_path: str,
    *,
    days: int = 7,
    window: str | None = None,
    force_live: bool = False,
) -> dict[str, Any]:
    now_utc = dt.datetime.now(dt.timezone.utc)
    window_config = _resolve_daysmart_trial_window(now_utc=now_utc, days=days, window=window)
    window_end_exclusive = _window_end_exclusive(window_config)
    with get_conn(db_path) as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT
                substr(coalesce(event_start, created_at, ''), 1, 10) AS event_date,
                customer_id
            FROM daysmart_class_registrations
            WHERE source_type = 'event_registration'
              AND lower(coalesce(event_name, '')) LIKE '%free trial class%'
              AND coalesce(event_start, created_at, '') >= ?
              AND coalesce(event_start, created_at, '') < ?
              AND coalesce(event_start, created_at, '') != ''
            ORDER BY event_date ASC
            """,
            (window_config["start_date"], window_end_exclusive),
        ).fetchall()
        existing_dates = {
            str(row["cache_date"])
            for row in conn.execute(
                "SELECT cache_date FROM daysmart_admin_checkin_cache"
            ).fetchall()
        }

    today_local = dt.datetime.now(LOCAL_TZ).date()
    candidate_dates: list[str] = []
    candidate_date_set: set[str] = set()
    customer_ids_by_date: dict[str, set[int]] = {}
    for row in rows:
        event_date = str(row["event_date"] or "")
        if not event_date:
            continue
        customer_id = _as_int(row["customer_id"])
        if customer_id is not None:
            customer_ids_by_date.setdefault(event_date, set()).add(customer_id)
        is_recent = False
        try:
            is_recent = (today_local - dt.date.fromisoformat(event_date)).days <= RECENT_CHECKIN_FORCE_DAYS
        except ValueError:
            is_recent = False
        if (force_live or is_recent or event_date not in existing_dates) and event_date not in candidate_date_set:
            candidate_dates.append(event_date)
            candidate_date_set.add(event_date)
    refreshed_reports: list[dict[str, Any]] = []
    targeted_by_date: dict[str, dict[int, list[dt.datetime]]] = {}
    targeted_meta: dict[str, Any] = {}
    targeted_customer_ids = set().union(
        *(customer_ids_by_date.get(day_key, set()) for day_key in candidate_dates)
    ) if candidate_dates else set()
    if _should_use_targeted_customer_checkins(
        {day_key: customer_ids_by_date.get(day_key, set()) for day_key in candidate_dates}
    ):
        targeted_by_date, targeted_meta = _load_admin_customer_checkins_for_dates(
            targeted_customer_ids,
            set(candidate_dates),
        )
    with get_conn(db_path) as conn:
        for day_key in candidate_dates:
            if targeted_meta.get("used_as_primary"):
                lookup = targeted_by_date.get(day_key, {})
                meta = _targeted_checkin_meta_for_date(day_key, lookup, targeted_meta)
                _store_admin_checkin_lookup(conn, day_key, lookup, meta)
            else:
                _ADMIN_CHECKIN_CACHE.pop(day_key, None)
                _, meta = _load_admin_location_checkins(
                    dt.date.fromisoformat(day_key),
                    conn=conn,
                    allow_live=True,
                    force_live=force_live or ((today_local - dt.date.fromisoformat(day_key)).days <= RECENT_CHECKIN_FORCE_DAYS),
                )
            refreshed_reports.append(meta)
        _clear_dashboard_cache_rows(conn, prefix="daysmart_trial_kpis")

    return {
        "ok": True,
        "window": window_config["label"],
        "free_trial_dates_in_window": len(customer_ids_by_date),
        "checkin_dates_refreshed": len(refreshed_reports),
        "checkin_entries": sum(int(item.get("entries") or 0) for item in refreshed_reports),
        "reports": refreshed_reports,
    }


def _hydrate_known_trial_team_registrations(db_path: str, registrations: list[dict[str, Any]]) -> int:
    missing = [
        registration
        for registration in registrations
        if str(registration.get("source_type") or "") == "registration"
        and _as_int(registration.get("team_or_event_id")) in ADULT_FREE_TRIAL_TEAM_IDS
        and _parse_ts(registration.get("event_start"), naive_tz=LOCAL_TZ) is None
    ]
    if not missing:
        return 0
    client = _daysmart_client()
    team_cache: dict[int, dict[str, Any] | None] = {}
    updated = 0
    with get_conn(db_path) as conn:
        for registration in missing:
            team_id = _as_int(registration.get("team_or_event_id"))
            if team_id is None:
                continue
            team_details = _load_team_free_trial_details(client, team_id, team_cache)
            event_start = _infer_registration_event_start(registration, team_details=team_details)
            if not event_start and team_id == 1043:
                created_dt = _parse_ts(registration.get("created_at"), naive_tz=LOCAL_TZ)
                event_start = created_dt.isoformat() if created_dt is not None else None
            if not event_start:
                continue
            event_name = (team_details or {}).get("team_name") or "Free Trial Class"
            registration["event_name"] = event_name
            registration["event_start"] = event_start
            conn.execute(
                """
                UPDATE daysmart_class_registrations
                SET event_name = ?, event_start = ?, updated_at = ?
                WHERE source_type = ? AND registration_id = ?
                """,
                (
                    event_name,
                    event_start,
                    _cache_now_iso(),
                    registration.get("source_type"),
                    registration.get("registration_id"),
                ),
            )
            updated += 1
    return updated


def _dedupe_free_trial_registrations(registrations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[tuple[int, str], dict[str, Any]] = {}
    for registration in registrations:
        customer_id = _as_int(registration.get("customer_id"))
        if customer_id is None:
            continue
        event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        if event_dt is None:
            key_dt = str(registration.get("registration_id") or "")
        else:
            key_dt = event_dt.astimezone(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()
        key = (customer_id, key_dt)
        existing = deduped.get(key)
        if existing is None:
            deduped[key] = registration
            continue
        existing_score = 2 if existing.get("source_type") == "event_registration" else 1
        incoming_score = 2 if registration.get("source_type") == "event_registration" else 1
        if incoming_score > existing_score:
            merged = dict(existing)
            merged.update({k: v for k, v in registration.items() if v not in (None, "")})
            deduped[key] = merged
        else:
            for field in ("event_name", "event_start", "full_name", "email", "phone_day", "phone_mobile"):
                if existing.get(field) in (None, "") and registration.get(field) not in (None, ""):
                    existing[field] = registration[field]
    return list(deduped.values())


def _trial_attendee_identity_key(registration: dict[str, Any]) -> tuple[str, str]:
    # DaySmart sometimes creates a second customer profile when the same person returns
    # for another trial. Count that as one attendee and keep the newest trial.
    name = _normalize_name(registration.get("full_name"))
    if name:
        return ("name", name)
    for field in ("email",):
        email = _normalize_email(registration.get(field))
        if email:
            return ("email", email)
    for field in ("normalized_phone_day", "normalized_phone_mobile", "phone_day", "phone_mobile"):
        phone = _normalize_phone(registration.get(field))
        if phone:
            return ("phone", phone)
    customer_id = _as_int(registration.get("customer_id"))
    return ("customer", str(customer_id or registration.get("registration_id") or id(registration)))


def _is_adult_free_trial_eventbrite_name(name: str | None) -> bool:
    name = _clean_text(name)
    if not name:
        return False
    if EVENTBRITE_TOTALS_ROW_RE.search(name):
        return False
    return bool(EVENTBRITE_ADULT_FREE_TRIAL_RE.search(name)) and not bool(EVENTBRITE_YOUTH_EXCLUSION_RE.search(name))


def _eventbrite_sales_csv_path() -> Path:
    settings = get_settings()
    configured = Path(settings.eventbrite_sales_csv_path).expanduser()
    if configured.is_absolute():
        return configured
    project_root = Path(__file__).resolve().parents[1]
    return project_root / configured


def _parse_eventbrite_sales_date(value: str | None) -> dt.date | None:
    cleaned = _clean_text(value)
    if not cleaned:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    return None


def _load_eventbrite_adult_free_trial_ticket_counts(
    *,
    start_date: dt.date,
    end_date: dt.date,
    granularity: str,
) -> tuple[dict[str, int], dict[str, int], dict[str, Any]]:
    csv_path = _eventbrite_sales_csv_path()
    meta: dict[str, Any] = {
        "configured": True,
        "source": "eventbrite_sales_csv",
        "path": str(csv_path),
        "rows_seen": 0,
        "matching_rows": 0,
        "classes_counted": 0,
        "tickets_counted": 0,
    }

    if not csv_path.exists():
        meta["configured"] = False
        meta["error"] = "Eventbrite Sales CSV not found."
        return {}, {}, meta

    try:
        with csv_path.open(newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
    except Exception as exc:
        meta["error"] = str(exc)
        return {}, {}, meta

    counts: dict[str, int] = {}
    class_counts: dict[str, int] = {}
    meta["rows_seen"] = len(rows)
    for row in rows:
        if not _is_adult_free_trial_eventbrite_name(row.get("Event name")):
            continue
        local_date = _parse_eventbrite_sales_date(row.get("Event start date"))
        if local_date is None:
            continue
        if local_date < start_date or local_date > end_date:
            continue
        bucket_key = _period_start(local_date, granularity).isoformat()
        class_counts[bucket_key] = class_counts.get(bucket_key, 0) + 1
        meta["matching_rows"] = int(meta["matching_rows"]) + 1
        meta["classes_counted"] = int(meta["classes_counted"]) + 1
        tickets = _as_int(row.get("Tickets sold")) or 0
        if tickets <= 0:
            continue
        counts[bucket_key] = counts.get(bucket_key, 0) + tickets
        meta["tickets_counted"] = int(meta["tickets_counted"]) + tickets
    return counts, class_counts, meta


def _build_kpi_timeseries_from_dashboard(dashboard: dict[str, Any], *, granularity: str) -> dict[str, Any]:
    granularity = granularity if granularity in {"week", "month", "quarter", "year"} else "week"
    window_payload = dashboard["window"]
    start_date = dt.date.fromisoformat(window_payload["start_date"])
    end_date = dt.date.fromisoformat(window_payload["end_date"])
    items = dashboard["items"]
    eventbrite_counts, eventbrite_class_counts, eventbrite_meta = _load_eventbrite_adult_free_trial_ticket_counts(
        start_date=start_date,
        end_date=end_date,
        granularity=granularity,
    )

    period_start = _period_start(start_date, granularity)
    period_buckets: dict[str, dict[str, Any]] = {}
    while period_start <= end_date:
        next_start = _next_period_start(period_start, granularity)
        period_end = min(end_date, next_start - dt.timedelta(days=1))
        key = period_start.isoformat()
        period_buckets[key] = {
            "label": _format_period_label(period_start, granularity),
            "start_date": period_start.isoformat(),
            "end_date": period_end.isoformat(),
            "leads": 0,
            "checked_in": 0,
            "packs": 0,
            "packs_10": 0,
            "packs_5": 0,
            "spend": 0,
            "eventbrite_tickets_sold": 0,
            "class_keys": set(),
        }
        period_start = next_start

    for item in items:
        started_at = _parse_ts(item.get("lead_started_at"))
        if started_at is None:
            continue
        lead_date = started_at.astimezone(LOCAL_TZ).date()
        bucket_key = _period_start(lead_date, granularity).isoformat()
        bucket = period_buckets.get(bucket_key)
        if bucket is None:
            continue
        class_key = item.get("checked_in_class_display") or item.get("trial_class_display") or item.get("scheduled_class_display")
        if class_key:
            bucket["class_keys"].add(str(class_key))
        bucket["leads"] += 1
        if item.get("has_checked_in"):
            bucket["checked_in"] += 1
        if item.get("has_pack"):
            bucket["packs"] += 1
        if item.get("has_10_pack"):
            bucket["packs_10"] += 1
        if item.get("has_5_pack"):
            bucket["packs_5"] += 1
        if item.get("has_spend"):
            bucket["spend"] += 1

    trend_items: list[dict[str, Any]] = []
    total_leads = 0
    total_checked_in = 0
    total_packs = 0
    total_packs_10 = 0
    total_packs_5 = 0
    total_spend = 0
    total_eventbrite_tickets_sold = 0
    total_class_keys: set[str] = set()
    for bucket in period_buckets.values():
        leads = int(bucket["leads"])
        checked_in = int(bucket["checked_in"])
        packs = int(bucket["packs"])
        packs_10 = int(bucket["packs_10"])
        packs_5 = int(bucket["packs_5"])
        spend = int(bucket["spend"])
        eventbrite_tickets_sold = int(eventbrite_counts.get(str(bucket["start_date"]), 0))
        class_count = int(eventbrite_class_counts.get(str(bucket["start_date"]), 0)) or len(bucket["class_keys"])
        total_leads += leads
        total_checked_in += checked_in
        total_packs += packs
        total_packs_10 += packs_10
        total_packs_5 += packs_5
        total_spend += spend
        total_eventbrite_tickets_sold += eventbrite_tickets_sold
        total_class_keys.update(bucket["class_keys"])
        trend_items.append(
            {
                "label": bucket["label"],
                "start_date": bucket["start_date"],
                "end_date": bucket["end_date"],
                "leads": leads,
                "checked_in": checked_in,
                "checkin_percentage": round((checked_in / leads) * 100, 1) if leads else 0.0,
                "packs": packs,
                "packs_10": packs_10,
                "packs_5": packs_5,
                "spend": spend,
                "eventbrite_tickets_sold": eventbrite_tickets_sold,
                "attended_percentage": round((leads / eventbrite_tickets_sold) * 100, 1)
                if eventbrite_tickets_sold
                else 0.0,
                "class_count": class_count,
                "average_packs_per_class": round((packs / class_count), 2) if class_count else 0.0,
                "pack_percentage": round((packs / checked_in) * 100, 1) if checked_in else 0.0,
                "spend_percentage": round((spend / checked_in) * 100, 1) if checked_in else 0.0,
            }
        )

    return {
        "granularity": granularity,
        "window_label": window_payload["label"],
        "window_start_date": window_payload["start_date"],
        "window_end_date": window_payload["end_date"],
        "totals": {
            "leads": total_leads,
            "checked_in": total_checked_in,
            "checkin_percentage": round((total_checked_in / total_leads) * 100, 1) if total_leads else 0.0,
            "packs": total_packs,
            "packs_10": total_packs_10,
            "packs_5": total_packs_5,
            "spend": total_spend,
            "eventbrite_tickets_sold": total_eventbrite_tickets_sold,
            "attended_percentage": round((total_leads / total_eventbrite_tickets_sold) * 100, 1)
            if total_eventbrite_tickets_sold
            else 0.0,
            "class_count": int(eventbrite_meta.get("classes_counted") or 0) or len(total_class_keys),
            "average_packs_per_class": round(
                total_packs / (int(eventbrite_meta.get("classes_counted") or 0) or len(total_class_keys)),
                2,
            )
            if (int(eventbrite_meta.get("classes_counted") or 0) or total_class_keys)
            else 0.0,
            "pack_percentage": round((total_packs / total_checked_in) * 100, 1) if total_checked_in else 0.0,
            "spend_percentage": round((total_spend / total_checked_in) * 100, 1) if total_checked_in else 0.0,
        },
        "eventbrite": eventbrite_meta,
        "items": trend_items,
    }


@_synchronized(_DASHBOARD_BUILD_LOCK)
def build_adult_kpi_dashboard(
    db_path: str,
    *,
    adult_inbox_id: int,
    days: int = 7,
    window: str | None = None,
    detail_level: str = "full",
    refresh: bool = False,
) -> dict[str, Any]:
    now_utc = dt.datetime.now(dt.timezone.utc)
    window_config = _resolve_window(now_utc=now_utc, days=days, window=window)
    window_start = window_config["start_date"]
    window_end_exclusive = _window_end_exclusive(window_config)
    detail_level = detail_level if detail_level in {"base", "full"} else "full"
    include_live_details = detail_level == "full"
    cache_key = _dashboard_cache_key(
        adult_inbox_id=adult_inbox_id,
        days=days,
        window=window,
        detail_level=detail_level,
    )

    with get_conn(db_path) as conn:
        if not refresh:
            cached = _load_dashboard_cache(conn, cache_key)
            if isinstance(cached, dict):
                return cached

        lead_rows = conn.execute(
            """
            SELECT id, inbox_id, contact_name, contact_number, started_at, closed_at, last_message_at, raw_json
            FROM conversations
            WHERE inbox_id = ?
              AND coalesce(started_at, '') >= ?
              AND coalesce(started_at, '') < ?
            ORDER BY coalesce(started_at, '') DESC, id DESC
            """,
            (adult_inbox_id, window_start, window_end_exclusive),
        ).fetchall()

        matched_rows: list[dict[str, Any]] = []
        all_customer_ids: set[int] = set()
        for row in lead_rows:
            lead = dict(row)
            customer = _find_adult_daysmart_customer(conn, lead)
            lead["daysmart_customer"] = customer
            matched_rows.append(lead)
            if customer is not None:
                all_customer_ids.add(int(customer["customer_id"]))

        membership_map = _load_membership_map(conn, all_customer_ids)
        # Normal page loads should use the persistent DaySmart cache. Live per-customer
        # fallbacks are reserved for an explicit refresh/sync so large windows stay fast.
        registration_map = _load_registration_map(
            conn,
            all_customer_ids,
            client=_daysmart_client() if include_live_details and refresh else None,
            allow_live_fallback=include_live_details and refresh,
        )

    registrations_by_conversation: dict[int, list[dict[str, Any]]] = {}
    relevant_dates: set[str] = set()
    customer_ids_by_date: dict[str, set[int]] = {}
    for lead in matched_rows:
        conversation_id = int(lead["id"])
        started_at = _parse_ts(lead.get("started_at"))
        customer = lead.get("daysmart_customer")
        customer_id = int(customer["customer_id"]) if customer is not None else None
        registrations = registration_map.get(customer_id or -1, [])
        filtered_registrations = _filter_registrations_for_lead(registrations, lead_started_at=started_at)
        registrations_by_conversation[conversation_id] = filtered_registrations
        for registration in filtered_registrations:
            event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
            if event_dt is not None:
                day_key = event_dt.astimezone(LOCAL_TZ).date().isoformat()
                relevant_dates.add(day_key)
                if customer_id is not None:
                    customer_ids_by_date.setdefault(day_key, set()).add(customer_id)

    checkins_by_date: dict[str, dict[int, list[dt.datetime]]] = {}
    attendance_reports: list[dict[str, Any]] = []
    if include_live_details:
        targeted_by_date: dict[str, dict[int, list[dt.datetime]]] = {}
        targeted_meta: dict[str, Any] = {}
        if refresh and _should_use_targeted_customer_checkins(customer_ids_by_date):
            targeted_customer_ids = set().union(*customer_ids_by_date.values())
            targeted_by_date, targeted_meta = _load_admin_customer_checkins_for_dates(
                targeted_customer_ids,
                set(customer_ids_by_date),
            )
        with get_conn(db_path) as conn:
            for day_key in sorted(relevant_dates):
                if targeted_meta.get("used_as_primary"):
                    lookup = targeted_by_date.get(day_key, {})
                    meta = _targeted_checkin_meta_for_date(day_key, lookup, targeted_meta)
                    _store_admin_checkin_lookup(conn, day_key, lookup, meta)
                else:
                    lookup, meta = _load_admin_location_checkins(
                        dt.date.fromisoformat(day_key),
                        conn=conn,
                        allow_live=refresh,
                    )
                checkins_by_date[day_key] = lookup
                attendance_reports.append(meta)

    client = _daysmart_client() if include_live_details else None
    pack_candidate_ids = (set(registration_map) | set(membership_map)) if include_live_details else set()
    if include_live_details and client is not None and refresh:
        with get_conn(db_path) as conn:
            pack_map = _load_pack_map(client, pack_candidate_ids, conn=conn)
    elif include_live_details:
        with get_conn(db_path) as conn:
            pack_map = _load_cached_pack_map(conn, pack_candidate_ids)
    else:
        pack_map = {}
    event_cache: dict[int, tuple[dt.datetime, dt.datetime]] = {}

    items: list[dict[str, Any]] = []
    unmatched_leads = 0
    filtered_mixed_inbox_leads = 0
    mixed_inbox_text_by_conversation: dict[int, str] = {}
    pre_november_conversation_ids = [
        int(lead["id"])
        for lead in matched_rows
        if _is_mixed_inbox_period(_parse_ts(lead.get("started_at")))
    ]
    if pre_november_conversation_ids:
        with get_conn(db_path) as conn:
            for conversation_id in pre_november_conversation_ids:
                mixed_inbox_text_by_conversation[conversation_id] = _conversation_text(conn, conversation_id)

    for lead in matched_rows:
        conversation_id = int(lead["id"])
        started_at = _parse_ts(lead.get("started_at"))
        closed_at = _parse_ts(lead.get("closed_at"))
        last_interaction_at = _parse_ts(lead.get("last_message_at"))
        customer = lead.get("daysmart_customer")
        customer_id = int(customer["customer_id"]) if customer is not None else None
        if customer_id is None:
            unmatched_leads += 1

        registrations = registrations_by_conversation.get(conversation_id, [])
        membership_labels = membership_map.get(customer_id or -1, [])
        if _is_mixed_inbox_period(started_at) and _is_likely_youth_lead_from_text(
            mixed_inbox_text_by_conversation.get(conversation_id, "")
        ):
            filtered_mixed_inbox_leads += 1
            continue
        pack_label = pack_map.get(customer_id or -1)
        now_local = now_utc.astimezone(LOCAL_TZ)

        checked_in_registration = None
        checked_in_at = None
        future_registrations: list[dict[str, Any]] = []
        past_unchecked: list[dict[str, Any]] = []
        for registration in registrations:
            event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
            if event_dt is None:
                continue
            if include_live_details and client is not None:
                checked_in, matched_at = _registration_checked_in(
                    registration,
                    checkins_by_date=checkins_by_date,
                    client=client,
                    event_cache=event_cache,
                )
            else:
                checked_in, matched_at = False, None
            if checked_in and checked_in_registration is None:
                checked_in_registration = registration
                checked_in_at = matched_at
            elif event_dt.astimezone(LOCAL_TZ) >= now_local:
                future_registrations.append(registration)
            else:
                past_unchecked.append(registration)

        future_registrations.sort(
            key=lambda item: _parse_ts(item.get("event_start") or item.get("created_at"), naive_tz=LOCAL_TZ) or now_utc
        )
        past_unchecked.sort(
            key=lambda item: _parse_ts(item.get("event_start") or item.get("created_at"), naive_tz=LOCAL_TZ) or now_utc,
            reverse=True,
        )

        scheduled_registration = future_registrations[0] if future_registrations else None
        recent_past_registration = past_unchecked[0] if past_unchecked else None
        displayed_registration = scheduled_registration or checked_in_registration or recent_past_registration

        has_scheduled = bool(registrations)
        has_checked_in = checked_in_registration is not None
        has_membership = bool(membership_labels)
        has_no_show = bool(
            recent_past_registration is not None
            and checked_in_registration is None
            and not future_registrations
            and not has_membership
        )
        lead_status = _lead_status(
            closed_at=closed_at,
            has_scheduled=has_scheduled,
            has_checked_in=has_checked_in,
            has_no_show=has_no_show,
            has_membership=has_membership,
            last_interaction_at=last_interaction_at,
            now=now_utc,
        )

        items.append(
            {
                "item_key": f"conversation:{conversation_id}",
                "conversation_id": conversation_id,
                "conversation_url": f"https://app.salesmessage.com/conversations/{conversation_id}",
                "lead_started_at": started_at.isoformat() if started_at else None,
                "lead_started_at_display": _format_local(started_at),
                "last_interaction_at": last_interaction_at.isoformat() if last_interaction_at else None,
                "last_interaction_at_display": _format_local(last_interaction_at),
                "name": _conversation_contact_name(lead),
                "phone": _conversation_contact_phone(lead) or "--",
                "daysmart_customer_id": customer_id,
                "daysmart_url": _daysmart_account_url(customer_id),
                "trial_class_display": _display_registration(displayed_registration),
                "scheduled_class_display": _display_registration(scheduled_registration),
                "checked_in_class_display": _display_registration(checked_in_registration),
                "checked_in_at": checked_in_at.isoformat() if checked_in_at else None,
                "checked_in_at_display": _format_local(checked_in_at) if checked_in_at else "--",
                "has_scheduled": has_scheduled,
                "has_checked_in": has_checked_in,
                "has_no_show": has_no_show,
                "has_membership": has_membership,
                "has_pack": bool(pack_label),
                "packs": [pack_label] if pack_label else [],
                "packs_display": pack_label or "--",
                "memberships": membership_labels,
                "memberships_display": ", ".join(membership_labels) if membership_labels else "--",
                "lead_status": lead_status,
            }
        )

    status_counts = Counter(item["lead_status"] for item in items)
    total_leads = len(items)
    scheduled = sum(1 for item in items if item["has_scheduled"])
    checked_in = sum(1 for item in items if item["has_checked_in"])
    packs = sum(1 for item in items if item["has_pack"])
    memberships = sum(1 for item in items if item["has_membership"])
    no_shows = sum(1 for item in items if item["has_no_show"])

    items.sort(
        key=lambda item: (
            item.get("lead_started_at") or "",
            item.get("name") or "",
        ),
        reverse=True,
    )

    summary_cards = [
        {"key": "new_leads", "label": "New Leads", "count": total_leads, "subtext": window_config["summary_subtext"]},
        {"key": "scheduled_trials", "label": "Scheduled", "count": scheduled, "subtext": _format_percent(scheduled, total_leads)},
        {"key": "checked_in_trials", "label": "Checked In", "count": checked_in, "subtext": _format_percent(checked_in, total_leads)},
        {"key": "packs", "label": "Packs", "count": packs, "subtext": _format_percent(packs, checked_in)},
        {"key": "no_shows", "label": "No-Shows", "count": no_shows, "subtext": _format_percent(no_shows, total_leads)},
    ]

    conversation_statuses = [
        {"label": label, "count": status_counts.get(label, 0)}
        for label in (
            "New",
            "Needs follow-up",
            "Scheduled",
            "Checked in",
            "No-show",
            "Membership purchased",
            "Lost",
        )
    ]

    payload = {
        "window": {
            "mode": window_config["mode"],
            "days": window_config["days"],
            "start_date": window_config["start_date"],
            "end_date": window_config["end_date"],
            "label": window_config["label"],
            "generated_at": now_utc.isoformat(),
            "detail_level": detail_level,
        },
        "summary": {
            "lead_conversations": total_leads,
            "scheduled_trials": scheduled,
            "checked_in_trials": checked_in,
            "packs": packs,
            "memberships": memberships,
            "no_shows": no_shows,
            "unmatched_leads": unmatched_leads,
            "filtered_mixed_inbox_leads": filtered_mixed_inbox_leads,
        },
        "summary_cards": summary_cards,
        "conversation_statuses": conversation_statuses,
        "data_quality": {
            "attendance_source": {
                "source": "admin_location_reports",
                "dates_queried": len(relevant_dates),
                "report_entries": sum(int(item.get("entries") or 0) for item in attendance_reports),
                "reports": attendance_reports,
            },
            "matched_lead_count": total_leads - unmatched_leads,
            "unmatched_lead_count": unmatched_leads,
            "filtered_mixed_inbox_leads": filtered_mixed_inbox_leads,
            "detail_rows": len(items),
        },
        "items": items,
    }
    try:
        with get_conn(db_path) as conn:
            _save_dashboard_cache(conn, cache_key, payload)
    except sqlite3.OperationalError as exc:
        if "database is locked" not in str(exc).lower():
            raise
    return payload


def build_adult_kpi_timeseries(
    db_path: str,
    *,
    adult_inbox_id: int,
    days: int = 7,
    window: str | None = None,
    granularity: str = "week",
    refresh: bool = False,
) -> dict[str, Any]:
    granularity = granularity if granularity in {"week", "month", "quarter", "year"} else "week"
    dashboard = build_adult_kpi_dashboard(
        db_path,
        adult_inbox_id=adult_inbox_id,
        days=days,
        window=window,
        detail_level="full",
        refresh=refresh,
    )
    window_payload = dashboard["window"]
    start_date = dt.date.fromisoformat(window_payload["start_date"])
    end_date = dt.date.fromisoformat(window_payload["end_date"])
    items = dashboard["items"]

    period_start = _period_start(start_date, granularity)
    period_buckets: dict[str, dict[str, Any]] = {}
    while period_start <= end_date:
        next_start = _next_period_start(period_start, granularity)
        period_end = min(end_date, next_start - dt.timedelta(days=1))
        key = period_start.isoformat()
        period_buckets[key] = {
            "label": _format_period_label(period_start, granularity),
            "start_date": period_start.isoformat(),
            "end_date": period_end.isoformat(),
            "leads": 0,
            "checked_in": 0,
            "packs": 0,
        }
        period_start = next_start

    for item in items:
        started_at = _parse_ts(item.get("lead_started_at"))
        if started_at is None:
            continue
        lead_date = started_at.astimezone(LOCAL_TZ).date()
        bucket_key = _period_start(lead_date, granularity).isoformat()
        bucket = period_buckets.get(bucket_key)
        if bucket is None:
            continue
        bucket["leads"] += 1
        if item.get("has_checked_in"):
            bucket["checked_in"] += 1
        if item.get("has_pack"):
            bucket["packs"] += 1

    trend_items: list[dict[str, Any]] = []
    total_leads = 0
    total_checked_in = 0
    total_packs = 0
    for bucket in period_buckets.values():
        leads = int(bucket["leads"])
        checked_in = int(bucket["checked_in"])
        packs = int(bucket["packs"])
        total_leads += leads
        total_checked_in += checked_in
        total_packs += packs
        trend_items.append(
            {
                "label": bucket["label"],
                "start_date": bucket["start_date"],
                "end_date": bucket["end_date"],
                "leads": leads,
                "checked_in": checked_in,
                "checkin_percentage": round((checked_in / leads) * 100, 1) if leads else 0.0,
                "packs": packs,
                "pack_percentage": round((packs / checked_in) * 100, 1) if checked_in else 0.0,
            }
        )

    return {
        "granularity": granularity,
        "window_label": window_payload["label"],
        "window_start_date": window_payload["start_date"],
        "window_end_date": window_payload["end_date"],
        "totals": {
            "leads": total_leads,
            "checked_in": total_checked_in,
            "checkin_percentage": round((total_checked_in / total_leads) * 100, 1) if total_leads else 0.0,
            "packs": total_packs,
            "pack_percentage": round((total_packs / total_checked_in) * 100, 1) if total_checked_in else 0.0,
        },
        "items": trend_items,
    }


@_synchronized(_DASHBOARD_BUILD_LOCK)
def build_daysmart_trial_kpi_dashboard(
    db_path: str,
    *,
    days: int = 7,
    window: str | None = None,
    detail_level: str = "full",
    refresh: bool = False,
) -> dict[str, Any]:
    now_utc = dt.datetime.now(dt.timezone.utc)
    window_config = _resolve_daysmart_trial_window(now_utc=now_utc, days=days, window=window)
    window_end_exclusive = _window_end_exclusive(window_config)
    detail_level = detail_level if detail_level in {"base", "full"} else "full"
    include_live_details = detail_level == "full"
    cache_key = _dashboard_cache_key(
        adult_inbox_id=0,
        days=days,
        window=window,
        detail_level=detail_level,
        namespace="daysmart_trial_kpis_v11",
    )

    with get_conn(db_path) as conn:
        if not refresh:
            cached = _load_dashboard_cache(conn, cache_key)
            if isinstance(cached, dict):
                return cached

        registrations = _load_free_trial_event_registrations(
            conn,
            window_start=window_config["start_date"],
            window_end_exclusive=window_end_exclusive,
            specific_event_only=True,
        )
        roster_customers: dict[int, dict[str, Any]] = {}

    hydrated_registrations = _hydrate_known_trial_team_registrations(db_path, registrations) if include_live_details else 0
    registrations = _dedupe_free_trial_registrations(registrations)

    relevant_dates: set[str] = set()
    customer_ids_by_date: dict[str, set[int]] = {}
    for registration in registrations:
        event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        if event_dt is not None:
            day_key = event_dt.astimezone(LOCAL_TZ).date().isoformat()
            relevant_dates.add(day_key)
            customer_id = _as_int(registration.get("customer_id"))
            if customer_id is not None:
                customer_ids_by_date.setdefault(day_key, set()).add(customer_id)

    checkins_by_date: dict[str, dict[int, list[dt.datetime]]] = {}
    attendance_reports: list[dict[str, Any]] = []
    if include_live_details:
        targeted_by_date: dict[str, dict[int, list[dt.datetime]]] = {}
        targeted_meta: dict[str, Any] = {}
        if refresh and _should_use_targeted_customer_checkins(customer_ids_by_date):
            targeted_customer_ids = set().union(*customer_ids_by_date.values())
            targeted_by_date, targeted_meta = _load_admin_customer_checkins_for_dates(
                targeted_customer_ids,
                set(customer_ids_by_date),
            )
        with get_conn(db_path) as conn:
            for day_key in sorted(relevant_dates):
                if targeted_meta.get("used_as_primary"):
                    lookup = targeted_by_date.get(day_key, {})
                    meta = _targeted_checkin_meta_for_date(day_key, lookup, targeted_meta)
                    _store_admin_checkin_lookup(conn, day_key, lookup, meta)
                else:
                    if refresh:
                        _ADMIN_CHECKIN_CACHE.pop(day_key, None)
                    lookup, meta = _load_admin_location_checkins(
                        dt.date.fromisoformat(day_key),
                        conn=conn,
                        allow_live=refresh,
                        force_live=refresh,
                    )
                checkins_by_date[day_key] = lookup
                attendance_reports.append(meta)
            manual_checkins = _merge_manual_trial_checkins(conn, checkins_by_date, relevant_dates)
            if manual_checkins:
                attendance_reports.append(
                    {
                        "source": "manual_trial_checkins",
                        "entries": manual_checkins,
                    }
                )

    attended_registrations: list[tuple[dict[str, Any], dt.datetime | None]] = []
    for registration in registrations:
        if include_live_details:
            checked_in, checked_in_at = _registration_checked_in_from_cached_event(
                registration,
                checkins_by_date=checkins_by_date,
            )
        else:
            checked_in, checked_in_at = True, None
        if checked_in:
            attended_registrations.append((registration, checked_in_at))

    roster_attended_count = 0

    attended_count_before_customer_dedupe = len(attended_registrations)

    all_customer_ids = {
        customer_id
        for registration, _ in attended_registrations
        if (customer_id := _as_int(registration.get("customer_id"))) is not None
    }
    trial_dates_by_customer = {
        customer_id: event_dt
        for registration, _ in attended_registrations
        if (customer_id := _as_int(registration.get("customer_id"))) is not None
        and (event_dt := _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ))
        is not None
    }
    trial_dates_by_entry = {
        _trial_pack_entry_key(customer_id, event_dt): (customer_id, event_dt)
        for registration, _ in attended_registrations
        if (customer_id := _as_int(registration.get("customer_id"))) is not None
        and (event_dt := _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ))
        is not None
    }

    with get_conn(db_path) as conn:
        membership_map = _load_membership_map(conn, all_customer_ids)
        cached_pack_map, cached_pack_entry_keys = _load_cached_pack_map_after_trial_entries(
            conn,
            trial_dates_by_entry,
        )
        cached_spend_map, cached_spend_customer_ids = _load_cached_spend_map_after_trial(
            conn,
            trial_dates_by_customer,
        )
    daysmart_client = _daysmart_client() if include_live_details else None
    pack_map = dict(cached_pack_map)
    missing_pack_trial_dates_by_entry = {
        entry_key: trial_entry
        for entry_key, trial_entry in trial_dates_by_entry.items()
        if entry_key not in cached_pack_entry_keys
    }
    if (
        include_live_details
        and daysmart_client is not None
        and window_config["mode"] != "all_time"
        and missing_pack_trial_dates_by_entry
    ):
        live_pack_map = _load_pack_map_after_trial_entries(
            daysmart_client,
            missing_pack_trial_dates_by_entry,
            window_days=30,
        )
        pack_map.update(live_pack_map)
        with get_conn(db_path) as conn:
            _save_pack_map_after_trial_entries_cache(conn, missing_pack_trial_dates_by_entry, live_pack_map)
    spend_map = dict(cached_spend_map)
    missing_spend_trial_dates = {
        customer_id: trial_dt
        for customer_id, trial_dt in trial_dates_by_customer.items()
        if customer_id not in cached_spend_customer_ids
    }
    if (
        include_live_details
        and daysmart_client is not None
        and window_config["mode"] != "all_time"
        and missing_spend_trial_dates
    ):
        spend_map.update(_load_spend_map_after_trial(daysmart_client, missing_spend_trial_dates))

    items: list[dict[str, Any]] = []
    for registration, checked_in_at in attended_registrations:
        customer_id = _as_int(registration.get("customer_id"))
        event_dt = _parse_ts(registration.get("event_start") or registration.get("created_at"), naive_tz=LOCAL_TZ)
        membership_labels = membership_map.get(customer_id or -1, [])
        countable_membership_labels = _countable_membership_labels(membership_labels)
        pack_entry_key = (
            _trial_pack_entry_key(customer_id, event_dt)
            if customer_id is not None and event_dt is not None
            else None
        )
        pack_label = pack_map.get(pack_entry_key or "")
        has_spend = bool(spend_map.get(customer_id or -1)) or bool(pack_label)
        phone_display = _format_phone_display(
            registration.get("phone_day"),
            registration.get("phone_mobile"),
            registration.get("normalized_phone_day"),
            registration.get("normalized_phone_mobile"),
        )
        items.append(
            {
                "item_key": f"daysmart_registration:{registration.get('registration_id')}",
                "conversation_id": None,
                "conversation_url": None,
                "lead_started_at": event_dt.isoformat() if event_dt else None,
                "lead_started_at_display": _format_local(event_dt),
                "last_interaction_at": None,
                "last_interaction_at_display": "--",
                "name": registration.get("full_name") or f"Customer {customer_id}",
                "phone": phone_display,
                "email": registration.get("email"),
                "daysmart_customer_id": customer_id,
                "daysmart_url": _daysmart_account_url(customer_id),
                "trial_class_display": _display_registration(registration),
                "scheduled_class_display": _display_registration(registration),
                "checked_in_class_display": _display_registration(registration),
                "checked_in_at": checked_in_at.isoformat() if checked_in_at else None,
                "checked_in_at_display": _format_local(checked_in_at) if checked_in_at else "--",
                "has_scheduled": True,
                "has_checked_in": True,
                "has_no_show": False,
                "has_membership": bool(countable_membership_labels),
                "has_staff_membership": any(_is_staff_membership_label(label) for label in membership_labels),
                "has_gold_membership": _has_gold_membership(membership_labels),
                "has_dropin_membership": _has_dropin_membership(membership_labels),
                "has_pack": bool(pack_label),
                "has_10_pack": pack_label == "10-Pack Classes",
                "has_5_pack": pack_label == "5-Pack Classes",
                "has_spend": has_spend,
                "packs": [pack_label] if pack_label else [],
                "packs_display": pack_label or "--",
                "spend_display": "Yes" if has_spend else "--",
                "memberships": membership_labels,
                "memberships_display": ", ".join(membership_labels) if membership_labels else "--",
                "lead_status": "Membership purchased" if countable_membership_labels else ("Pack purchased" if pack_label else ("Spent" if has_spend else "Checked in")),
            }
        )

    items.sort(
        key=lambda item: (
            item.get("lead_started_at") or "",
            item.get("name") or "",
        ),
        reverse=True,
    )

    total_leads = len(items)
    scheduled = total_leads
    checked_in = total_leads
    packs = sum(1 for item in items if item["has_pack"])
    spend = sum(1 for item in items if item.get("has_spend"))
    memberships = sum(1 for item in items if item["has_membership"])
    gold_memberships = sum(1 for item in items if item.get("has_gold_membership"))
    dropin_memberships = sum(1 for item in items if item.get("has_dropin_membership"))
    no_shows = 0

    summary_cards = [
        {
            "key": "trial_attendees",
            "label": "Trial Attendees",
            "count": total_leads,
            "subtext": window_config["summary_subtext"],
        },
        {"key": "packs", "label": "Packs", "count": packs, "subtext": _format_percent(packs, checked_in)},
        {"key": "spend", "label": "Spend", "count": spend, "subtext": _format_percent(spend, checked_in)},
        {
            "key": "memberships",
            "label": "Memberships",
            "count": memberships,
            "subtext": f"{_format_percent(memberships, checked_in)} | Gold {gold_memberships} | Drop-In {dropin_memberships}",
        },
    ]

    payload = {
        "window": {
            "mode": window_config["mode"],
            "days": window_config["days"],
            "start_date": window_config["start_date"],
            "end_date": window_config["end_date"],
            "label": window_config["label"],
            "generated_at": now_utc.isoformat(),
            "detail_level": detail_level,
        },
        "summary": {
            "lead_conversations": total_leads,
            "trial_attendees": total_leads,
            "scheduled_trials": scheduled,
            "checked_in_trials": checked_in,
            "packs": packs,
            "spend": spend,
            "memberships": memberships,
            "gold_memberships": gold_memberships,
            "dropin_memberships": dropin_memberships,
            "no_shows": no_shows,
            "registrations_checked": len(registrations),
            "roster_customers_checked": len(roster_customers),
            "roster_attendances_matched": roster_attended_count,
            "duplicate_trial_attendances_removed": attended_count_before_customer_dedupe - total_leads,
            "historical_registrations_hydrated": hydrated_registrations,
        },
        "summary_cards": summary_cards,
        "conversation_statuses": [],
        "data_quality": {
            "attendance_source": {
                "source": "daysmart_event_registrations_and_admin_location_reports",
                "dates_queried": len(relevant_dates),
                "report_entries": sum(int(item.get("entries") or 0) for item in attendance_reports),
                "reports": attendance_reports,
            },
            "matched_lead_count": total_leads,
            "unmatched_lead_count": 0,
            "detail_rows": len(items),
            "registrations_checked": len(registrations),
            "roster_customers_checked": len(roster_customers),
            "roster_attendances_matched": roster_attended_count,
            "duplicate_trial_attendances_removed": attended_count_before_customer_dedupe - total_leads,
        },
        "items": items,
    }
    try:
        with get_conn(db_path) as conn:
            _save_dashboard_cache(conn, cache_key, payload)
    except sqlite3.OperationalError as exc:
        if "database is locked" not in str(exc).lower():
            raise
    return payload


def build_daysmart_trial_kpi_timeseries(
    db_path: str,
    *,
    days: int = 7,
    window: str | None = None,
    granularity: str = "week",
    refresh: bool = False,
) -> dict[str, Any]:
    dashboard = build_daysmart_trial_kpi_dashboard(
        db_path,
        days=days,
        window=window,
        detail_level="full",
        refresh=refresh,
    )
    return _build_kpi_timeseries_from_dashboard(dashboard, granularity=granularity)


def build_adult_kpi_email_preview(
    db_path: str,
    *,
    adult_inbox_id: int,
    days: int = 7,
    window: str | None = None,
) -> dict[str, str]:
    dashboard = build_adult_kpi_dashboard(db_path, adult_inbox_id=adult_inbox_id, days=days, window=window)
    window = dashboard["window"]
    summary = dashboard["summary"]
    statuses = dashboard["conversation_statuses"]
    items = dashboard["items"][:12]

    start_label = dt.date.fromisoformat(window["start_date"]).strftime("%b %-d")
    end_label = dt.date.fromisoformat(window["end_date"]).strftime("%b %-d, %Y")
    subject = f"Adult Trial Funnel - {start_label} to {end_label}"

    lines = [
        f"Adult trial funnel for {start_label} to {end_label}",
        "",
        f"New leads: {summary['lead_conversations']}",
        f"Scheduled: {summary['scheduled_trials']}",
        f"Checked in: {summary['checked_in_trials']}",
        f"No-shows: {summary['no_shows']}",
        f"Memberships purchased: {summary['memberships']}",
        "",
        "Conversation status:",
    ]
    for status in statuses:
        lines.append(f"- {status['label']}: {status['count']}")

    if items:
        lines.extend(["", "Recent lead detail:"])
        for item in items:
            class_part = f" | {item['trial_class_display']}" if item.get("trial_class_display") else ""
            lines.append(f"- {item['name']} | {item['lead_status']}{class_part}")

    return {
        "subject": subject,
        "body": "\n".join(lines),
    }
