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
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None


PROJECT_DIR = Path(__file__).resolve().parent
BOOKING_ROOT = "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports"
API_BASE = os.getenv("DASH_API_BASE", "https://api.dashplatform.com").rstrip("/")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EVENTS_PAGE_SIZE = 1000
LOOKUP_PAGE_SIZE = 500


def parse_iso8601(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def strip_html(text: str | None) -> str:
    if not text:
        return ""
    without_tags = re.sub(r"<[^>]+>", " ", text)
    condensed = re.sub(r"\s+", " ", without_tags).strip()
    return condensed


class DashClient:
    def __init__(self) -> None:
        self.client_id, self.client_secret = self._load_credentials()
        self._http = self._build_http_client()
        self._token = None
        self._token_expires_at = 0.0
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

    def _cached_lookup(self, key: str) -> dict[str, str]:
        now = time.time()
        if key == "event_types":
            ts, lookup = self._event_types_cache
            if now - ts < 900 and lookup:
                return lookup
            lookup = self._fetch_lookup("/api/v1/event-types")
            self._event_types_cache = (now, lookup)
            return lookup
        if key == "leagues":
            ts, lookup = self._leagues_cache
            if now - ts < 900 and lookup:
                return lookup
            lookup = self._fetch_lookup("/api/v1/leagues")
            self._leagues_cache = (now, lookup)
            return lookup
        if key == "resource_areas":
            ts, lookup = self._resource_areas_cache
            if now - ts < 900 and lookup:
                return lookup
            lookup = self._fetch_lookup("/api/v1/resource-areas")
            self._resource_areas_cache = (now, lookup)
            return lookup

        ts, lookup = self._resources_cache
        if now - ts < 900 and lookup:
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
            for future, team_id in futures.items():
                try:
                    value = future.result()
                except Exception:
                    value = None
                if value:
                    names[team_id] = value

        return names

    def _compute_events_for_date(self, selected_date: date) -> tuple[list[dict], int | None]:
        day_start = datetime.combine(selected_date, dtime.min)
        day_end = day_start + timedelta(days=1)
        selected_key = selected_date.isoformat()
        now = time.time()

        # Pull core lookup maps in parallel to reduce cold-start request latency.
        with ThreadPoolExecutor(max_workers=4) as pool:
            fut_event_types = pool.submit(self._cached_lookup, "event_types")
            fut_resources = pool.submit(self._cached_lookup, "resources")
            fut_resource_areas = pool.submit(self._cached_lookup, "resource_areas")
            fut_leagues = pool.submit(self._cached_lookup, "leagues")
            event_types = fut_event_types.result()
            resources = fut_resources.result()
            resource_areas = fut_resource_areas.result()
            leagues = fut_leagues.result()

        parsed_events = []
        page = 1
        hint = self._page_hint_by_date.get(selected_key)
        if hint and now - hint[0] < self._page_hint_ttl:
            page = max(1, hint[1])

        first_match_page = None
        while page <= 40:
            response = self._request_json(
                "GET",
                "/api/v1/events",
                params={"page[size]": EVENTS_PAGE_SIZE, "page[number]": page},
            )
            rows = response.get("data", [])
            if not rows:
                break

            hit_future = False
            for row in rows:
                attrs = row.get("attributes", {})
                start_dt = parse_iso8601(attrs.get("start"))
                end_dt = parse_iso8601(attrs.get("end"))
                if not start_dt or not end_dt:
                    continue

                # API appears sorted by start ascending, so we can stop after passing this day.
                if start_dt >= day_end:
                    hit_future = True
                    break
                if start_dt < day_start:
                    continue

                if first_match_page is None:
                    first_match_page = page

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

                category = event_types.get(event_type_id)
                league_name = leagues.get(league_id)
                description = strip_html(
                    attrs.get("description") or attrs.get("desc") or attrs.get("best_description")
                )
                event_kind = self._event_kind(event_type_id, category, league_name, description, vteam_id)
                parsed_events.append(
                    {
                        "id": str(row.get("id")),
                        "event_kind": event_kind,
                        "team_id": team_id,
                        "league_name": league_name,
                        "description": description,
                        "category": category,
                        "resource_id": resource_id,
                        "resource_area_id": resource_area_id,
                        "start_time": start_dt,
                        "end_time": end_dt,
                    }
                )

            if hit_future:
                break
            page += 1

        bookable_team_ids = {
            str(item["team_id"])
            for item in parsed_events
            if item["event_kind"] == "bookable" and item["team_id"]
        }
        team_names = self._prefetch_team_names(bookable_team_ids)

        events = []
        for item in parsed_events:
            event_kind = str(item["event_kind"])
            team_id = str(item["team_id"]) if item["team_id"] else None
            team_name = team_names.get(team_id) if team_id else None
            league_name = item["league_name"]
            description = str(item["description"])
            category = item["category"]

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

            if re.search(r"staff[\s-]*court", title, re.IGNORECASE):
                title = "Private Event"
                program_category = "Private Event"
                booking_url = None
                clickable = False

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
                }
            )

        events.sort(key=lambda e: e["start_time"])
        return events, first_match_page

    def get_events_for_date(self, selected_date: date) -> list[dict]:
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
            events, first_match_page = self._compute_events_for_date(selected_date)
            now = time.time()
            self._events_by_date_cache[selected_key] = (now, list(events))
            if first_match_page is not None:
                self._page_hint_by_date[selected_key] = (now, first_match_page)
            return events
        finally:
            with self._events_inflight_lock:
                done_event = self._events_inflight.pop(selected_key, None)
                if done_event is not None:
                    done_event.set()


CLIENT = DashClient()


class CalendarHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_DIR), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/events":
            return self._handle_events_api(parsed)
        return super().do_GET()

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

    def _send_json(self, payload: dict | list, status: int = 200):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    port = int(os.getenv("PORT", "8010"))
    server = ThreadingHTTPServer(("0.0.0.0", port), CalendarHandler)
    print(f"QBK calendar server running on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
