#!/usr/bin/env python3
"""Serve the QBK customer calendar with a live DaySmart events endpoint."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time as dtime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None


PROJECT_DIR = Path(__file__).resolve().parent
REPO_ROOT = PROJECT_DIR.parent
APP_DIR_NAMES = {
    "/daily": "qbk-customer-calendar",
    "/daily-analytics": "qbk-daily-analytics-dashboard",
    "/league-analytics": "qbk-league-analytics-dashboard",
    "/adult-classes-week": "qbk-weekly-adult-calendar",
    "/adult-dropins-week": "qbk-weekly-adult-dropins-calendar",
    "/teen-dropins-week": "qbk-weekly-teen-dropins-calendar",
    "/youth-week": "qbk-weekly-youth-programs-calendar",
    "/teen-upcoming": "qbk-teen-upcoming-widget",
    "/league-page": "qbk-league-page",
}


def _resolve_app_dir(dirname: str) -> Path:
    bundled = PROJECT_DIR / dirname
    if bundled.exists():
        return bundled
    return REPO_ROOT / dirname


APP_ROUTE_DIRS = {
    route: _resolve_app_dir(dirname) for route, dirname in APP_DIR_NAMES.items()
}
BOOKING_ROOT = "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports"
BEACH_LIONS_TRYOUT_URL = "https://www.eventbrite.com/e/qbk-sports-beach-volleyball-youth-club-spring-tryouts-tickets-1983086995587?aff=oddtdtcreator"
API_BASE = os.getenv("DASH_API_BASE", "https://api.dashplatform.com").rstrip("/")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EVENTS_PAGE_SIZE = 1000
LOOKUP_PAGE_SIZE = 500
EVENTS_MAX_PAGES = int(os.getenv("QBK_EVENTS_MAX_PAGES", "40"))
LOOKUP_CACHE_TTL = int(os.getenv("QBK_LOOKUP_CACHE_TTL", "21600"))
API_JSON_CACHE_CONTROL = os.getenv(
    "QBK_API_CACHE_CONTROL",
    "public, max-age=30, stale-while-revalidate=120",
)
ADULT_CLINIC_TERMS = (
    "beachmode",
    "sandy hands",
    "beach bombers",
    "beach bomberts",
    "serve / serve receive",
    "serve/serve receive",
    "serve receive",
    "shots shop",
)
LOCAL_TZ = ZoneInfo(os.getenv("QBK_LOCAL_TIMEZONE", "America/New_York"))
TEEN_UPCOMING_CACHE_CONTROL = os.getenv(
    "QBK_TEEN_UPCOMING_CACHE_CONTROL",
    "public, max-age=21600, stale-while-revalidate=604800",
)
CLICK_ANALYTICS_CACHE_CONTROL = "no-store"
CLICK_ANALYTICS_LOG_PATH = PROJECT_DIR / ".runtime-cache" / "daily-click-events.jsonl"
LEAGUE_CLICK_ANALYTICS_LOG_PATH = PROJECT_DIR / ".runtime-cache" / "league-click-events.jsonl"
TRACKED_ANALYTICS_HOSTS = {"qbksports.com", "www.qbksports.com"}
LOCAL_ANALYTICS_HOSTS = {"localhost", "127.0.0.1", "::1"}
TRACKED_ANALYTICS_SITE_IDS = {"qbksports"}
TRUSTED_WIX_ANALYTICS_SUFFIX = ".filesusr.com"


def parse_iso8601(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def strip_html(text) -> str:
    if text is None:
        return ""
    if isinstance(text, dict):
        for key in ("text", "value", "html", "description", "content", "plain_text"):
            value = text.get(key)
            if value:
                return strip_html(value)
        return strip_html(" ".join(str(value) for value in text.values() if value))
    if isinstance(text, (list, tuple, set)):
        return " ".join(part for part in (strip_html(item) for item in text) if part)
    text = str(text)
    if not text:
        return ""
    if "<" not in text:
        return re.sub(r"\s+", " ", text).strip()
    without_tags = re.sub(r"<[^>]+>", " ", text)
    condensed = re.sub(r"\s+", " ", without_tags).strip()
    return condensed


class ClickAnalyticsStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    @staticmethod
    def _sanitize_text(value: object, fallback: str = "") -> str:
        text = strip_html(value)
        return text[:500] if text else fallback

    @staticmethod
    def _sanitize_filters(raw_filters: object) -> list[str]:
        if not isinstance(raw_filters, list):
            return []
        cleaned = []
        for item in raw_filters:
            text = strip_html(item)
            if text:
                cleaned.append(text[:100])
        return cleaned[:20]

    def record(self, payload: dict[str, object], headers) -> dict[str, object]:
        event = {
            "server_received_at": datetime.now(LOCAL_TZ).isoformat(),
            "calendar": self._sanitize_text(payload.get("calendar"), "daily"),
            "action": self._sanitize_text(payload.get("action"), "click"),
            "button_type": self._sanitize_text(payload.get("button_type"), "unknown"),
            "button_label": self._sanitize_text(payload.get("button_label"), "Unknown"),
            "destination_url": self._sanitize_text(payload.get("destination_url")),
            "selected_date": self._sanitize_text(payload.get("selected_date")),
            "category": self._sanitize_text(payload.get("category")),
            "court": self._sanitize_text(payload.get("court")),
            "view_mode": self._sanitize_text(payload.get("view_mode")),
            "page_path": self._sanitize_text(payload.get("page_path")),
            "referrer": self._sanitize_text(payload.get("referrer")),
            "active_filters": self._sanitize_filters(payload.get("active_filters")),
            "user_agent": self._sanitize_text(headers.get("User-Agent"), "")[:250],
        }
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        return event

    def clear(self) -> None:
        with self._lock:
            if self.path.exists():
                self.path.unlink()

    def _read_events(self, days: int) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        cutoff = datetime.now(LOCAL_TZ) - timedelta(days=max(1, days))
        rows: list[dict[str, object]] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                stamp = parse_iso8601(item.get("server_received_at"))
                if stamp is None:
                    continue
                if stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=LOCAL_TZ)
                else:
                    stamp = stamp.astimezone(LOCAL_TZ)
                if stamp < cutoff:
                    continue
                rows.append(item)
        return rows

    def summary(self, days: int = 30, limit: int = 20) -> dict[str, object]:
        events = self._read_events(days)
        button_counts = Counter()
        type_counts = Counter()
        category_counts = Counter()
        date_counts = Counter()

        for event in events:
            label = strip_html(event.get("button_label")) or "Unknown"
            button_counts[label] += 1
            button_type = strip_html(event.get("button_type")) or "unknown"
            type_counts[button_type] += 1
            category = strip_html(event.get("category")) or "uncategorized"
            category_counts[category] += 1
            selected_date = strip_html(event.get("selected_date"))
            if selected_date:
                date_counts[selected_date] += 1

        recent = list(reversed(events[-50:]))
        return {
            "window_days": days,
            "total_clicks": len(events),
            "unique_buttons": len(button_counts),
            "top_buttons": [
                {"label": label, "count": count}
                for label, count in button_counts.most_common(max(1, limit))
            ],
            "button_types": [
                {"type": label, "count": count}
                for label, count in type_counts.most_common()
            ],
            "categories": [
                {"label": label, "count": count}
                for label, count in category_counts.most_common()
            ],
            "dates": [
                {"date": raw_date, "count": count}
                for raw_date, count in date_counts.most_common()
            ],
            "recent_clicks": recent,
        }


class DashClient:
    def __init__(self) -> None:
        self.client_id, self.client_secret = self._load_credentials()
        self._http = self._build_http_client()
        self._token = None
        self._token_expires_at = 0.0
        self._token_lock = threading.Lock()
        self._event_types_cache = (0.0, {})
        self._resources_cache = (0.0, {})
        self._resource_areas_cache = (0.0, {})
        self._leagues_cache = (0.0, {})
        self._team_name_cache: dict[str, str] = {}
        self._events_cache_ttl = int(os.getenv("QBK_EVENTS_CACHE_TTL", "120"))
        self._events_by_date_cache: dict[str, tuple[float, list[dict]]] = {}
        self._page_hint_ttl = int(os.getenv("QBK_PAGE_HINT_TTL", "3600"))
        self._page_hint_by_date: dict[str, tuple[float, int]] = {}
        self._events_inflight: dict[str, threading.Event] = {}
        self._events_inflight_lock = threading.Lock()
        self._prefetch_adjacent_days = max(0, int(os.getenv("QBK_PREFETCH_ADJ_DAYS", "1")))
        self._prefetch_pool = ThreadPoolExecutor(max_workers=2)
        self._teen_upcoming_cache_lock = threading.Lock()
        self._teen_upcoming_cache_path = PROJECT_DIR / ".runtime-cache" / "teen-upcoming.json"
        self._teen_upcoming_cache: dict | None = None
        self._enable_startup_prewarm = os.getenv("QBK_PREWARM_ON_STARTUP", "1").lower() not in {
            "0",
            "false",
            "no",
        }
        if self._enable_startup_prewarm:
            threading.Thread(target=self._warmup_metadata, daemon=True).start()

    def _get_page_hint(self, selected_date: date, now: float) -> int | None:
        selected_key = selected_date.isoformat()
        exact = self._page_hint_by_date.get(selected_key)
        if exact and now - exact[0] < self._page_hint_ttl:
            return max(1, int(exact[1]))

        best_delta = None
        best_page = None
        for raw_key, (ts, page) in self._page_hint_by_date.items():
            if now - ts >= self._page_hint_ttl:
                continue
            try:
                hint_date = datetime.strptime(raw_key, "%Y-%m-%d").date()
            except ValueError:
                continue
            delta = abs((hint_date - selected_date).days)
            if delta > 3:
                continue
            if best_delta is None or delta < best_delta:
                best_delta = delta
                best_page = int(page)

        if best_page is None:
            return None
        return max(1, best_page)

    def _build_http_client(self) -> httpx.Client:
        verify: bool | str = True
        try:
            import certifi  # type: ignore

            verify = certifi.where()
        except Exception:
            verify = True
        return httpx.Client(
            base_url=API_BASE,
            timeout=30.0,
            verify=verify,
            headers={
                "Accept": "application/vnd.api+json",
                "Content-Type": "application/vnd.api+json",
            },
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )

    def _load_credentials(self) -> tuple[str, str]:
        client_id = os.getenv("DASH_API_CLIENT_ID")
        client_secret = os.getenv("DASH_API_SECRET")
        if client_id and client_secret:
            return client_id, client_secret

        config_path = Path.home() / ".codex" / "config.toml"
        if tomllib is None or not config_path.exists():
            raise RuntimeError(
                "Missing DASH credentials. Set DASH_API_CLIENT_ID and DASH_API_SECRET in your shell."
            )

        config = tomllib.loads(config_path.read_text())
        env = (
            config.get("mcp_servers", {})
            .get("qbk-sports-admin", {})
            .get("env", {})
        )
        client_id = env.get("DASH_API_CLIENT_ID")
        client_secret = env.get("DASH_API_SECRET")
        if not client_id or not client_secret:
            raise RuntimeError(
                "Could not find qbk-sports-admin credentials in ~/.codex/config.toml."
            )
        return client_id, client_secret

    def _request_json(
        self,
        method: str,
        path: str,
        params: dict[str, str | int] | None = None,
        body: dict | None = None,
        use_auth: bool = True,
    ) -> dict:
        headers = {}
        if use_auth:
            headers["Authorization"] = f"Bearer {self._get_token()}"

        response = self._http.request(method, path, params=params, json=body, headers=headers)
        if response.status_code == 401 and use_auth:
            # token may have expired between requests
            self._token = None
            self._token_expires_at = 0.0
            headers["Authorization"] = f"Bearer {self._get_token()}"
            response = self._http.request(method, path, params=params, json=body, headers=headers)

        if response.status_code >= 400:
            raise RuntimeError(f"Dash API {response.status_code}: {response.text[:320]}")

        return response.json()

    def _get_token(self) -> str:
        now = time.time()
        if self._token and now < self._token_expires_at - 60:
            return self._token

        with self._token_lock:
            now = time.time()
            if self._token and now < self._token_expires_at - 60:
                return self._token

            response = self._request_json(
                method="POST",
                path="/v1/auth/token",
                body={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
                use_auth=False,
            )

            token = response.get("access_token") or response.get("token")
            if not token:
                raise RuntimeError("Dash API auth returned no access token.")

            expires_in = int(response.get("expires_in", 900))
            self._token = token
            self._token_expires_at = now + expires_in
            return token

    def _warmup_metadata(self) -> None:
        try:
            self._get_token()
            self._cached_lookup("event_types")
            self._cached_lookup("resources")
            self._cached_lookup("resource_areas")
            self._cached_lookup("leagues")
        except Exception:
            # Best-effort warmup only.
            return

    def _cached_lookup(self, key: str) -> dict[str, str]:
        now = time.time()
        if key == "event_types":
            ts, lookup = self._event_types_cache
            if now - ts < LOOKUP_CACHE_TTL and lookup:
                return lookup
            lookup = self._fetch_lookup("/api/v1/event-types")
            self._event_types_cache = (now, lookup)
            return lookup
        if key == "leagues":
            ts, lookup = self._leagues_cache
            if now - ts < LOOKUP_CACHE_TTL and lookup:
                return lookup
            lookup = self._fetch_lookup("/api/v1/leagues")
            self._leagues_cache = (now, lookup)
            return lookup
        if key == "resource_areas":
            ts, lookup = self._resource_areas_cache
            if now - ts < LOOKUP_CACHE_TTL and lookup:
                return lookup
            lookup = self._fetch_lookup("/api/v1/resource-areas")
            self._resource_areas_cache = (now, lookup)
            return lookup

        ts, lookup = self._resources_cache
        if now - ts < LOOKUP_CACHE_TTL and lookup:
            return lookup
        lookup = self._fetch_lookup("/api/v1/resources")
        self._resources_cache = (now, lookup)
        return lookup

    @staticmethod
    def _court_info(resource_name: str | None, resource_area_name: str | None) -> tuple[str | None, str | None]:
        area = (resource_area_name or "").lower()
        base = (resource_name or "").lower()
        if "left court" in area:
            return "left", "Left Court"
        if "middle court" in area:
            return "middle", "Middle Court"
        if "right court" in area:
            return "right", "Right Court"
        if "all court" in base:
            return "all", "All Courts"
        if "left court" in base:
            return "left", "Left Court"
        if "middle court" in base:
            return "middle", "Middle Court"
        if "right court" in base:
            return "right", "Right Court"
        return None, resource_area_name or resource_name

    @staticmethod
    def _is_customer_bookable(category: str | None, league_name: str | None, description: str) -> bool:
        haystack = " ".join(
            x for x in [category or "", league_name or "", description or ""] if x
        ).lower()
        allow_terms = ("camp", "class", "drop-in", "drop in")
        return any(term in haystack for term in allow_terms)

    @staticmethod
    def _event_kind(
        event_type_id: str,
        category: str | None,
        league_name: str | None,
        description: str,
        vteam_id: object,
    ) -> str:
        haystack = " ".join(
            x for x in [event_type_id or "", category or "", league_name or "", description or ""] if x
        ).lower()

        if (
            event_type_id.lower() == "r"
            or "rental" in haystack
            or "catch corner" in haystack
            or "catchcorner" in haystack
        ):
            return "rental"

        if any(token in haystack for token in ("camp", "class", "drop-in", "drop in")):
            return "bookable"

        if event_type_id.lower() == "g" or vteam_id is not None or "league" in haystack or "game" in haystack:
            return "league"

        return "private_event"

    @staticmethod
    def _program_category(category: str | None, league_name: str | None, description: str) -> str | None:
        haystack = " ".join(
            x for x in [category or "", league_name or "", description or ""] if x
        ).lower()
        if "drop-in" in haystack or "drop in" in haystack:
            return "Drop-in"
        if "class" in haystack:
            return "Class"
        if "camp" in haystack:
            return "Camp"
        return category

    def _get_team_name(self, team_id: str | None) -> str | None:
        if not team_id:
            return None
        if team_id in self._team_name_cache:
            return self._team_name_cache[team_id]

        response = self._request_json("GET", f"/api/v1/teams/{team_id}")
        attrs = response.get("data", {}).get("attributes", {})
        name = attrs.get("name") or attrs.get("title")
        if name:
            value = str(name)
            self._team_name_cache[team_id] = value
            return value
        return None

    def _fetch_lookup(self, path: str) -> dict[str, str]:
        lookup: dict[str, str] = {}
        page = 1
        while page <= 10:
            response = self._request_json(
                "GET",
                path,
                params={"page[size]": LOOKUP_PAGE_SIZE, "page[number]": page},
            )
            rows = response.get("data", [])
            if not rows:
                break

            for row in rows:
                row_id = str(row.get("id"))
                attrs = row.get("attributes", {})
                name = attrs.get("name") or attrs.get("title") or attrs.get("description")
                if row_id and name:
                    lookup[row_id] = str(name)

            if len(rows) < LOOKUP_PAGE_SIZE:
                break
            page += 1

        return lookup

    def _prefetch_team_names(self, team_ids: set[str]) -> dict[str, str]:
        names: dict[str, str] = {}
        ids_to_fetch: list[str] = []
        for team_id in team_ids:
            if team_id in self._team_name_cache:
                names[team_id] = self._team_name_cache[team_id]
            else:
                ids_to_fetch.append(team_id)

        if not ids_to_fetch:
            return names

        max_workers = min(8, len(ids_to_fetch))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(self._get_team_name, team_id): team_id for team_id in ids_to_fetch}
            for future in as_completed(futures):
                team_id = futures[future]
                try:
                    value = future.result()
                except Exception:
                    value = None
                if value:
                    names[team_id] = value

        return names

    def _schedule_prefetch_date(self, target_date: date) -> None:
        selected_key = target_date.isoformat()
        now = time.time()
        cached = self._events_by_date_cache.get(selected_key)
        if cached and now - cached[0] < self._events_cache_ttl:
            return

        def _worker() -> None:
            try:
                self.get_events_for_date(target_date, schedule_prefetch=False)
            except Exception:
                # Best-effort warmup only.
                return

        try:
            self._prefetch_pool.submit(_worker)
        except Exception:
            return

    def _schedule_adjacent_prefetch(self, selected_date: date, include_selected: bool = False) -> None:
        if self._prefetch_adjacent_days <= 0:
            return
        for offset in range(-self._prefetch_adjacent_days, self._prefetch_adjacent_days + 1):
            if offset == 0 and not include_selected:
                continue
            self._schedule_prefetch_date(selected_date + timedelta(days=offset))

    def _compute_events_for_date(self, selected_date: date) -> tuple[list[dict], int | None]:
        day_start = datetime.combine(selected_date, dtime.min)
        day_end = day_start + timedelta(days=1)
        selected_key = selected_date.isoformat()
        
        def _to_int(value) -> int | None:
            if value is None:
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        event_types: dict[str, str] = {}
        resources: dict[str, str] = {}
        resource_areas: dict[str, str] = {}
        leagues: dict[str, str] = {}
        event_summaries: dict[str, dict] = {}
        parsed_events = []
        included_team_names: dict[str, str] = {}
        page = 1
        while page <= EVENTS_MAX_PAGES:
            response = self._request_json(
                "GET",
                "/api/v1/events",
                params={
                    "page[size]": EVENTS_PAGE_SIZE,
                    "page[number]": page,
                    "filter[start_date]": selected_key,
                    "include": "homeTeam,visitingTeam,resource,resourceArea,eventType,league,summary",
                },
            )
            rows = response.get("data", [])
            included = response.get("included", [])
            for included_item in included:
                included_id = included_item.get("id")
                if included_id is None:
                    continue
                attrs = included_item.get("attributes", {})
                item_type = str(included_item.get("type") or "")
                label = attrs.get("name") or attrs.get("title") or attrs.get("description")
                if not label:
                    continue
                item_key = str(included_id)
                value = str(label)
                if item_type == "teams":
                    included_team_names[item_key] = value
                    self._team_name_cache[item_key] = value
                elif item_type == "event-types":
                    event_types[item_key] = value
                elif item_type == "resources":
                    resources[item_key] = value
                elif item_type == "resource-areas":
                    resource_areas[item_key] = value
                elif item_type == "leagues":
                    leagues[item_key] = value
                elif item_type == "event-summaries":
                    event_summaries[item_key] = {
                        "registered_count": _to_int(attrs.get("registered_count")),
                        "remaining_registration_slots": _to_int(attrs.get("remaining_registration_slots")),
                        "registration_status": attrs.get("registration_status"),
                    }
            if not rows:
                break

            for row in rows:
                attrs = row.get("attributes", {})
                start_dt = parse_iso8601(attrs.get("start"))
                end_dt = parse_iso8601(attrs.get("end"))
                if not start_dt or not end_dt:
                    continue

                # Keep a strict window check as a safety guard.
                if start_dt < day_start or start_dt >= day_end:
                    continue

                event_type_id = str(attrs.get("event_type_id")) if attrs.get("event_type_id") is not None else ""
                league_id = str(attrs.get("league_id")) if attrs.get("league_id") is not None else ""
                resource_id = str(attrs.get("resource_id")) if attrs.get("resource_id") is not None else ""
                resource_area_id = str(attrs.get("resource_area_id")) if attrs.get("resource_area_id") is not None else ""
                team_id = (
                    attrs.get("hteam_id")
                    or attrs.get("vteam_id")
                    or attrs.get("rteam_id")
                )
                team_id = str(team_id) if team_id is not None else None
                vteam_id = attrs.get("vteam_id")
                description = strip_html(
                    attrs.get("description") or attrs.get("desc") or attrs.get("best_description")
                )
                parsed_events.append(
                    {
                        "id": str(row.get("id")),
                        "event_type_id": event_type_id,
                        "league_id": league_id,
                        "vteam_id": vteam_id,
                        "team_id": team_id,
                        "description": description,
                        "resource_id": resource_id,
                        "resource_area_id": resource_area_id,
                        "start_time": start_dt,
                        "end_time": end_dt,
                        "register_capacity": _to_int(attrs.get("register_capacity")),
                    }
                )

            if len(rows) < EVENTS_PAGE_SIZE:
                break
            page += 1

        needed_event_type_ids = {
            str(item["event_type_id"])
            for item in parsed_events
            if item["event_type_id"] and str(item["event_type_id"]) not in event_types
        }
        needed_league_ids = {
            str(item["league_id"])
            for item in parsed_events
            if item["league_id"] and str(item["league_id"]) not in leagues
        }
        needed_resource_ids = {
            str(item["resource_id"])
            for item in parsed_events
            if item["resource_id"] and str(item["resource_id"]) not in resources
        }
        needed_resource_area_ids = {
            str(item["resource_area_id"])
            for item in parsed_events
            if item["resource_area_id"] and str(item["resource_area_id"]) not in resource_areas
        }

        if needed_event_type_ids:
            fallback = self._cached_lookup("event_types")
            for row_id in needed_event_type_ids:
                value = fallback.get(row_id)
                if value:
                    event_types[row_id] = value
        if needed_league_ids:
            fallback = self._cached_lookup("leagues")
            for row_id in needed_league_ids:
                value = fallback.get(row_id)
                if value:
                    leagues[row_id] = value
        if needed_resource_ids:
            fallback = self._cached_lookup("resources")
            for row_id in needed_resource_ids:
                value = fallback.get(row_id)
                if value:
                    resources[row_id] = value
        if needed_resource_area_ids:
            fallback = self._cached_lookup("resource_areas")
            for row_id in needed_resource_area_ids:
                value = fallback.get(row_id)
                if value:
                    resource_areas[row_id] = value

        bookable_team_ids: set[str] = set()
        for item in parsed_events:
            team_id = item["team_id"]
            if not team_id:
                continue
            event_type_id = str(item["event_type_id"])
            league_id = str(item["league_id"])
            category = event_types.get(event_type_id)
            league_name = leagues.get(league_id)
            event_kind = self._event_kind(
                event_type_id,
                category,
                league_name,
                item["description"],
                item["vteam_id"],
            )
            if event_kind == "bookable":
                bookable_team_ids.add(str(team_id))
        team_names = {team_id: name for team_id, name in included_team_names.items() if team_id in bookable_team_ids}
        missing_team_ids = bookable_team_ids - set(team_names.keys())
        if missing_team_ids:
            team_names.update(self._prefetch_team_names(missing_team_ids))

        events = []
        for item in parsed_events:
            event_type_id = str(item["event_type_id"])
            league_id = str(item["league_id"])
            category = event_types.get(event_type_id)
            league_name = leagues.get(league_id)
            event_kind = self._event_kind(
                event_type_id,
                category,
                league_name,
                item["description"],
                item["vteam_id"],
            )
            team_id = str(item["team_id"]) if item["team_id"] else None
            team_name = team_names.get(team_id) if team_id else None
            description = str(item["description"])
            summary = event_summaries.get(str(item["id"]), {})
            register_capacity = _to_int(item.get("register_capacity"))
            registered_count = _to_int(summary.get("registered_count"))
            remaining_registration_slots = _to_int(summary.get("remaining_registration_slots"))
            registration_status = summary.get("registration_status")

            if event_kind == "league":
                title = league_name or "League Match"
                program_category = "League"
                booking_url = None
                clickable = False
            elif event_kind == "rental":
                title = "Private Rental"
                program_category = "Rental"
                booking_url = None
                clickable = False
            elif event_kind == "bookable":
                title = team_name or league_name or description or category
                program_category = self._program_category(category, team_name or league_name, description)
                if team_id:
                    booking_url = f"{BOOKING_ROOT}/teams/{team_id}"
                else:
                    booking_url = BOOKING_ROOT
                clickable = True
            else:
                title = "Private Event"
                program_category = "Private Event"
                booking_url = None
                clickable = False

            if not title:
                title = "QBK Event"
            if len(title) > 120:
                title = f"{title[:117]}..."

            if (
                selected_date.isoformat() == "2026-03-22"
                and event_kind == "bookable"
                and title.lower() == "tryouts - beach lions"
            ):
                booking_url = BEACH_LIONS_TRYOUT_URL
                clickable = True

            location = resources.get(str(item["resource_id"]))
            sub_resource = resource_areas.get(str(item["resource_area_id"]))
            court_key, court_label = self._court_info(location, sub_resource)
            if court_label:
                location = court_label

            events.append(
                {
                    "id": str(item["id"]),
                    "title": title,
                    "category": program_category,
                    "location": location,
                    "sub_resource": sub_resource,
                    "court_key": court_key,
                    "start_time": item["start_time"].isoformat(),
                    "end_time": item["end_time"].isoformat(),
                    "booking_url": booking_url,
                    "clickable": clickable,
                    "register_capacity": register_capacity,
                    "registered_count": registered_count,
                    "remaining_registration_slots": remaining_registration_slots,
                    "registration_status": registration_status,
                }
            )

        events.sort(key=lambda e: e["start_time"])
        return events, 1 if events else None

    def get_events_for_date(self, selected_date: date, *, schedule_prefetch: bool = True) -> list[dict]:
        selected_key = selected_date.isoformat()
        now = time.time()
        cached = self._events_by_date_cache.get(selected_key)
        if cached and now - cached[0] < self._events_cache_ttl:
            return list(cached[1])

        is_fetch_owner = False
        with self._events_inflight_lock:
            inflight = self._events_inflight.get(selected_key)
            if inflight is None:
                inflight = threading.Event()
                self._events_inflight[selected_key] = inflight
                is_fetch_owner = True

        if not is_fetch_owner:
            inflight.wait(timeout=35.0)
            cached = self._events_by_date_cache.get(selected_key)
            if cached:
                return list(cached[1])

        try:
            events, _ = self._compute_events_for_date(selected_date)
            now = time.time()
            self._events_by_date_cache[selected_key] = (now, list(events))
            if schedule_prefetch:
                self._schedule_adjacent_prefetch(selected_date)
            return events
        finally:
            with self._events_inflight_lock:
                done_event = self._events_inflight.pop(selected_key, None)
                if done_event is not None:
                    done_event.set()

    def get_adult_class_events_for_week(self, selected_date: date) -> dict:
        week_start = selected_date - timedelta(days=selected_date.weekday())
        week_days = [week_start + timedelta(days=i) for i in range(7)]

        with ThreadPoolExecutor(max_workers=7) as pool:
            futures = {
                pool.submit(self.get_events_for_date, day, schedule_prefetch=False): day
                for day in week_days
            }
            day_events: dict[date, list[dict]] = {}
            for future in as_completed(futures):
                day = futures[future]
                day_events[day] = future.result()

        events: list[dict] = []
        for idx, day in enumerate(week_days):
            for event in day_events.get(day, []):
                title = str(event.get("title") or "").lower()
                has_adult = "adult" in title
                is_free_trial_class = bool(re.search(r"free[\s-]*trial[\s-]*class", title))
                is_adult_class = has_adult and "class" in title
                is_adult_camp_or_clinic = has_adult and ("camp" in title or "clinic" in title)
                is_known_adult_program = any(
                    token in title for token in ADULT_CLINIC_TERMS
                )
                include = (
                    is_free_trial_class
                    or is_adult_class
                    or is_adult_camp_or_clinic
                    or is_known_adult_program
                )
                if not include:
                    continue
                booking_url = event.get("booking_url")
                if not booking_url or booking_url == "#":
                    continue

                output = dict(event)
                output["week_day_index"] = idx
                events.append(output)

        events.sort(key=lambda e: e.get("start_time", ""))
        return {
            "week_start": week_start.isoformat(),
            "week_end": (week_start + timedelta(days=6)).isoformat(),
            "events": events,
        }

    @staticmethod
    def _normalize_upcoming_teen_event(event: dict) -> dict | None:
        source_title = str(event.get("title") or "").strip()
        lower_title = source_title.lower()
        category_lower = str(event.get("category") or "").lower()
        booking_url = event.get("booking_url")
        if not booking_url or booking_url == "#":
            return None

        is_glow_party = bool(re.search(r"glow[\s-]*in[\s-]*the[\s-]*dark[\s-]*party", lower_title))
        is_drop_in = "drop-in" in category_lower or "drop in" in category_lower or bool(
            re.search(r"drop[\s-]*in", lower_title)
        )
        is_teen_like = bool(re.search(r"\bteens?\b", lower_title))

        if not is_glow_party and (not is_drop_in or not is_teen_like):
            return None

        return {
            "id": str(event.get("id") or ""),
            "title": "Teen Glow In The Dark Party" if is_glow_party else "Teen Drop In",
            "start_time": str(event.get("start_time") or ""),
            "end_time": str(event.get("end_time") or ""),
            "booking_url": str(booking_url),
            "location": event.get("location"),
            "sub_resource": event.get("sub_resource"),
        }

    def get_upcoming_teen_events(
        self,
        *,
        limit: int = 5,
        start_date: date | None = None,
        lookahead_days: int = 21,
    ) -> list[dict]:
        target_limit = max(1, min(limit, 20))
        current_date = start_date or date.today()
        upcoming: list[dict] = []

        for offset in range(max(1, lookahead_days)):
            selected_date = current_date + timedelta(days=offset)
            day_events = self.get_events_for_date(selected_date)
            for event in day_events:
                normalized = self._normalize_upcoming_teen_event(event)
                if normalized is None:
                    continue
                upcoming.append(normalized)

            if len(upcoming) >= target_limit:
                break

        upcoming.sort(key=lambda item: item.get("start_time", ""))
        return upcoming[:target_limit]

    def _current_teen_upcoming_refresh_key(self) -> str:
        now_local = datetime.now(LOCAL_TZ)
        weekday = now_local.weekday()
        if weekday >= 4:
            boundary_date = now_local.date() - timedelta(days=weekday - 4)
        else:
            boundary_date = now_local.date() - timedelta(days=weekday)
        return boundary_date.isoformat()

    def _load_teen_upcoming_cache_from_disk(self) -> dict | None:
        try:
            if not self._teen_upcoming_cache_path.is_file():
                return None
            payload = json.loads(self._teen_upcoming_cache_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return None
            events = payload.get("events")
            refresh_key = payload.get("refresh_key")
            if not isinstance(events, list) or not isinstance(refresh_key, str):
                return None
            return payload
        except Exception:
            return None

    def _write_teen_upcoming_cache_to_disk(self, payload: dict) -> None:
        try:
            self._teen_upcoming_cache_path.parent.mkdir(parents=True, exist_ok=True)
            self._teen_upcoming_cache_path.write_text(
                json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            return

    def get_cached_upcoming_teen_events(self, *, limit: int = 5) -> list[dict]:
        target_limit = max(1, min(limit, 20))
        refresh_key = self._current_teen_upcoming_refresh_key()

        with self._teen_upcoming_cache_lock:
            cached = self._teen_upcoming_cache
            if cached is None:
                cached = self._load_teen_upcoming_cache_from_disk()
                if cached is not None:
                    self._teen_upcoming_cache = cached

            if cached and cached.get("refresh_key") == refresh_key:
                return list(cached.get("events") or [])[:target_limit]

            stale_events = list((cached or {}).get("events") or [])
            try:
                events = self.get_upcoming_teen_events(limit=20)
            except Exception:
                if stale_events:
                    return stale_events[:target_limit]
                raise

            payload = {
                "refresh_key": refresh_key,
                "updated_at": datetime.now(LOCAL_TZ).isoformat(),
                "events": events,
            }
            self._teen_upcoming_cache = payload
            self._write_teen_upcoming_cache_to_disk(payload)
            return events[:target_limit]


CLIENT = DashClient()
CLICK_ANALYTICS = ClickAnalyticsStore(CLICK_ANALYTICS_LOG_PATH)
LEAGUE_CLICK_ANALYTICS = ClickAnalyticsStore(LEAGUE_CLICK_ANALYTICS_LOG_PATH)


class CalendarHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO_ROOT), **kwargs)

    def _is_local_request(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        client_host = (self.client_address[0] or "").lower()
        return (
            host.startswith("localhost")
            or host.startswith("127.0.0.1")
            or host.startswith("[::1]")
            or client_host in {"127.0.0.1", "::1"}
        )

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/events-week":
            return self._handle_events_week_api(parsed)
        if parsed.path == "/api/events":
            return self._handle_events_api(parsed)
        if parsed.path == "/api/click-analytics":
            return self._handle_click_analytics_api(parsed)
        if parsed.path == "/api/league-click-analytics":
            return self._handle_league_click_analytics_api(parsed)
        if parsed.path == "/api/teen-upcoming":
            return self._handle_teen_upcoming_api(parsed)
        if parsed.path in {"/daily-analytics", "/daily-analytics/", "/league-analytics", "/league-analytics/"} and not self._is_local_request():
            return self.send_error(404, "Not found")

        if parsed.path in {"", "/"}:
            return self._redirect("/daily/")
        if parsed.path in APP_ROUTE_DIRS:
            return self._redirect(f"{parsed.path}/")

        static_path = self._resolve_static_path(parsed.path)
        if static_path is not None:
            if not static_path.is_file():
                return self.send_error(404, "File not found")
            self.path = "/" + static_path.relative_to(REPO_ROOT).as_posix()
            return super().do_GET()

        return self.send_error(404, "Not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/track-click":
            return self._handle_track_click_api()
        if parsed.path == "/api/track-league-click":
            return self._handle_track_league_click_api()
        return self.send_error(404, "Not found")

    def _resolve_static_path(self, raw_path: str) -> Path | None:
        path = urllib.parse.unquote(raw_path)
        for route, app_dir in APP_ROUTE_DIRS.items():
            base = app_dir.resolve()
            if path == route or path == f"{route}/":
                return base / "index.html"
            prefix = f"{route}/"
            if path.startswith(prefix):
                relative = path[len(prefix):]
                candidate = (base / relative).resolve()
                try:
                    candidate.relative_to(base)
                except ValueError:
                    return None
                if candidate.is_dir():
                    return candidate / "index.html"
                return candidate
        return None

    def _redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()
        return None

    def _handle_events_week_api(self, parsed: urllib.parse.ParseResult):
        query = urllib.parse.parse_qs(parsed.query)
        raw_date = (query.get("date") or [date.today().isoformat()])[0]

        if not DATE_RE.match(raw_date):
            return self._send_json({"error": "Invalid date. Use YYYY-MM-DD."}, status=400)

        try:
            selected = datetime.strptime(raw_date, "%Y-%m-%d").date()
        except ValueError:
            return self._send_json({"error": "Invalid calendar date."}, status=400)

        try:
            payload = CLIENT.get_adult_class_events_for_week(selected)
        except Exception as exc:  # broad catch for clean client errors
            return self._send_json(
                {
                    "error": "Could not load weekly live events.",
                    "details": str(exc),
                },
                status=502,
            )

        return self._send_json(payload)

    def _handle_events_api(self, parsed: urllib.parse.ParseResult):
        query = urllib.parse.parse_qs(parsed.query)
        raw_date = (query.get("date") or [date.today().isoformat()])[0]

        if not DATE_RE.match(raw_date):
            return self._send_json({"error": "Invalid date. Use YYYY-MM-DD."}, status=400)

        try:
            selected = datetime.strptime(raw_date, "%Y-%m-%d").date()
        except ValueError:
            return self._send_json({"error": "Invalid calendar date."}, status=400)

        try:
            events = CLIENT.get_events_for_date(selected)
        except Exception as exc:  # broad catch for clean client errors
            return self._send_json(
                {
                    "error": "Could not load live events.",
                    "details": str(exc),
                },
                status=502,
            )

        return self._send_json(events)

    def _handle_teen_upcoming_api(self, parsed: urllib.parse.ParseResult):
        query = urllib.parse.parse_qs(parsed.query)
        raw_limit = (query.get("limit") or ["5"])[0]

        try:
            limit = int(raw_limit)
        except ValueError:
            return self._send_json({"error": "Invalid limit. Use an integer."}, status=400)

        try:
            events = CLIENT.get_cached_upcoming_teen_events(limit=limit)
        except Exception as exc:
            return self._send_json(
                {
                    "error": "Could not load upcoming teen events.",
                    "details": str(exc),
                },
                status=502,
            )

        return self._send_json(events, cache_control=TEEN_UPCOMING_CACHE_CONTROL)

    def _read_json_body(self) -> dict[str, object]:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            content_length = int(raw_length)
        except ValueError:
            raise ValueError("Invalid content length.")
        if content_length <= 0 or content_length > 65536:
            raise ValueError("Invalid request size.")
        body = self.rfile.read(content_length)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Invalid JSON payload.") from exc
        if not isinstance(payload, dict):
            raise ValueError("JSON payload must be an object.")
        return payload

    def _handle_track_click_api(self):
        try:
            payload = self._read_json_body()
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, status=400, cache_control=CLICK_ANALYTICS_CACHE_CONTROL)

        event = self._record_analytics_event(payload, CLICK_ANALYTICS)
        if event.get("ignored"):
            return self._send_json(event, cache_control=CLICK_ANALYTICS_CACHE_CONTROL)
        return self._send_json({"ok": True, "event": event}, cache_control=CLICK_ANALYTICS_CACHE_CONTROL)

    def _handle_click_analytics_api(self, parsed: urllib.parse.ParseResult):
        query = urllib.parse.parse_qs(parsed.query)
        raw_days = (query.get("days") or ["30"])[0]
        raw_limit = (query.get("limit") or ["20"])[0]
        try:
            days = max(1, min(365, int(raw_days)))
            limit = max(1, min(100, int(raw_limit)))
        except ValueError:
            return self._send_json(
                {"error": "Invalid days or limit value."},
                status=400,
                cache_control=CLICK_ANALYTICS_CACHE_CONTROL,
            )

        summary = CLICK_ANALYTICS.summary(days=days, limit=limit)
        return self._send_json(
            summary,
            cache_control=CLICK_ANALYTICS_CACHE_CONTROL,
            allow_origin="*",
        )

    def _handle_track_league_click_api(self):
        try:
            payload = self._read_json_body()
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, status=400, cache_control=CLICK_ANALYTICS_CACHE_CONTROL)

        event = self._record_analytics_event(payload, LEAGUE_CLICK_ANALYTICS)
        if event.get("ignored"):
            return self._send_json(event, cache_control=CLICK_ANALYTICS_CACHE_CONTROL)
        return self._send_json({"ok": True, "event": event}, cache_control=CLICK_ANALYTICS_CACHE_CONTROL)

    def _handle_league_click_analytics_api(self, parsed: urllib.parse.ParseResult):
        query = urllib.parse.parse_qs(parsed.query)
        raw_days = (query.get("days") or ["30"])[0]
        raw_limit = (query.get("limit") or ["20"])[0]
        try:
            days = max(1, min(365, int(raw_days)))
            limit = max(1, min(100, int(raw_limit)))
        except ValueError:
            return self._send_json(
                {"error": "Invalid days or limit value."},
                status=400,
                cache_control=CLICK_ANALYTICS_CACHE_CONTROL,
            )

        summary = LEAGUE_CLICK_ANALYTICS.summary(days=days, limit=limit)
        return self._send_json(
            summary,
            cache_control=CLICK_ANALYTICS_CACHE_CONTROL,
            allow_origin="*",
        )

    def _record_analytics_event(self, payload: dict[str, object], store: ClickAnalyticsStore):
        referrer = strip_html(payload.get("referrer"))
        source_host = strip_html(payload.get("source_host")).lower()
        site_id = strip_html(payload.get("site_id")).lower()
        try:
            referrer_host = urllib.parse.urlparse(referrer).hostname or ""
        except Exception:
            referrer_host = ""
        referrer_host = referrer_host.lower()
        if source_host in LOCAL_ANALYTICS_HOSTS:
            return {
                "ok": True,
                "ignored": True,
                "reason": "local_source",
            }
        if site_id in TRACKED_ANALYTICS_SITE_IDS:
            return store.record(payload, self.headers)
        if referrer_host and not self._is_trusted_analytics_referrer(referrer_host):
            return {
                "ok": True,
                "ignored": True,
                "reason": "untracked_referrer",
            }
        return store.record(payload, self.headers)

    @staticmethod
    def _is_trusted_analytics_referrer(referrer_host: str) -> bool:
        if not referrer_host:
            return True
        if referrer_host in TRACKED_ANALYTICS_HOSTS:
            return True
        return (
            referrer_host.endswith(TRUSTED_WIX_ANALYTICS_SUFFIX)
            and "qbksports" in referrer_host
        )

    def _send_json(
        self,
        payload: dict | list,
        status: int = 200,
        cache_control: str | None = None,
        allow_origin: str | None = None,
    ):
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", cache_control or API_JSON_CACHE_CONTROL)
        if allow_origin:
            self.send_header("Access-Control-Allow-Origin", allow_origin)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    port = int(os.getenv("PORT", "8015"))
    server = ThreadingHTTPServer(("0.0.0.0", port), CalendarHandler)
    print(f"QBK calendar suite running on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
