from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import os
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .adult_kpis import (
    build_adult_kpi_dashboard,
    build_adult_kpi_email_preview,
    build_adult_kpi_timeseries,
    build_daysmart_trial_kpi_dashboard,
    build_daysmart_trial_kpi_timeseries,
    clear_adult_kpi_caches,
    refresh_adult_kpi_daysmart_detail_cache,
    refresh_historical_known_trial_team_registrations,
    refresh_historical_daysmart_trial_pack_cache,
    refresh_historical_daysmart_trial_spend_cache,
    refresh_daysmart_trial_checkin_history,
    refresh_daysmart_trial_attendee_source,
    refresh_recent_daysmart_trial_pack_cache,
    refresh_recent_daysmart_trial_spend_cache,
    refresh_recent_known_trial_team_registrations,
    refresh_recent_daysmart_trial_registrations,
)
from .config import get_settings
from .db import get_conn, init_db
from .daysmart import DaysmartApiError, DaysmartClient
from .ingest import sync_conversations
from .salesmessage import SalesmessageApiError, SalesmessageClient
from .unified import sync_daysmart_to_unified

app = FastAPI(title="QBK Adult Trial KPI Dashboard", version="0.1.0")
settings = get_settings()
init_db(settings.database_url)
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

sync_state_lock = threading.Lock()
sync_state: dict[str, Any] = {
    "running": False,
    "stage": "idle",
    "started_at": None,
    "finished_at": None,
    "last_error": None,
    "last_result": None,
    "salesmessage_progress": None,
}
ADULT_LEAD_CUTOFF_DATE = "2025-01-01"
ADULT_LEAD_CUTOFF_TIMESTAMP = "2025-01-01T00:00:00+00:00"
APP_PASSWORD = os.getenv("APP_PASSWORD", "qbkadmin")
AUTH_COOKIE_NAME = "qbk_adult_auth"
AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30


class SyncRequest(BaseModel):
    filters: list[str] = Field(default_factory=lambda: ["open", "closed", "pending", "unassigned", "unread"])
    inbox_ids: list[int] | None = None
    min_last_message_at: str | None = ADULT_LEAD_CUTOFF_TIMESTAMP
    conversation_page_size: int = 100
    message_page_size: int = 0
    max_message_pages_per_conversation: int = 0


class HostedSyncRequest(SyncRequest):
    daysmart_max_pages: int = 25
    daysmart_page_size: int = 100


class DaySmartSyncRequest(BaseModel):
    max_pages: int = 25
    page_size: int = 100


class DaySmartTrialAttendeeRefreshRequest(BaseModel):
    days: int = 7
    window: str | None = None
    page_size: int = 200
    force_checkins: bool = False
    refresh_registrations: bool = False
    refresh_recent_registrations: bool = True
    refresh_historical_registrations: bool = False
    refresh_historical_packs: bool = False


class LoginRequest(BaseModel):
    password: str



def _set_sync_state(updates: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    if updates:
        merged.update(updates)
    if kwargs:
        merged.update(kwargs)
    with sync_state_lock:
        sync_state.update(merged)
        return dict(sync_state)



def _get_sync_state() -> dict[str, Any]:
    with sync_state_lock:
        return dict(sync_state)



def _auth_signature(payload: str) -> str:
    return hmac.new(APP_PASSWORD.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()



def _auth_token() -> str:
    payload = "authenticated"
    return f"{payload}.{_auth_signature(payload)}"



def _is_authenticated(request: Request) -> bool:
    token = request.cookies.get(AUTH_COOKIE_NAME, "")
    if "." not in token:
        return False
    payload, signature = token.split(".", 1)
    if payload != "authenticated":
        return False
    return hmac.compare_digest(signature, _auth_signature(payload))


@app.middleware("http")
async def require_auth(request: Request, call_next):
    public_paths = {"/", "/health", "/api/auth/status", "/api/login"}
    path = request.url.path
    if path in public_paths or path.startswith("/static"):
        return await call_next(request)
    if not _is_authenticated(request):
        return JSONResponse(status_code=401, content={"detail": "Authentication required."})
    return await call_next(request)



def _run_hosted_sync(req: HostedSyncRequest) -> None:
    _set_sync_state(
        running=True,
        stage="syncing_salesmessage",
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        finished_at=None,
        last_error=None,
        last_result=None,
        salesmessage_progress=None,
    )
    try:
        salesmessage_result = sync(req)
        _set_sync_state(stage="syncing_daysmart", last_result={"salesmessage": salesmessage_result})
        daysmart_result = sync_daysmart(
            DaySmartSyncRequest(max_pages=req.daysmart_max_pages, page_size=req.daysmart_page_size)
        )
        clear_adult_kpi_caches(settings.database_url)
        _set_sync_state(
            running=False,
            stage="completed",
            finished_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            last_result={"salesmessage": salesmessage_result, "daysmart": daysmart_result},
            last_error=None,
            salesmessage_progress=None,
        )
    except Exception as exc:
        _set_sync_state(
            running=False,
            stage="failed",
            finished_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            last_error=str(exc),
        )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def ui() -> FileResponse:
    return FileResponse(static_dir / "adult-kpis.html")


@app.get("/adult-kpis")
def adult_kpis_ui() -> FileResponse:
    return FileResponse(static_dir / "adult-kpis.html")


@app.get("/daysmart-trial-kpis")
def daysmart_trial_kpis_ui() -> FileResponse:
    return FileResponse(static_dir / "daysmart-trial-kpis.html")


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict[str, bool]:
    return {"authenticated": _is_authenticated(request)}


@app.post("/api/login")
def login(req: LoginRequest, request: Request) -> JSONResponse:
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Incorrect password.")
    response = JSONResponse({"ok": True, "authenticated": True})
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=_auth_token(),
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        max_age=AUTH_COOKIE_MAX_AGE,
        path="/",
    )
    return response


@app.post("/api/logout")
def logout() -> JSONResponse:
    response = JSONResponse({"ok": True})
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")
    return response


@app.post("/sync")
def sync(req: SyncRequest) -> dict[str, Any]:
    client = SalesmessageClient(
        token=settings.salesmessage_api_token,
        base_url=settings.salesmessage_base_url,
    )
    try:
        stats = sync_conversations(
            client=client,
            db_path=settings.database_url,
            filters=req.filters,
            conv_page_size=req.conversation_page_size,
            message_page_size=req.message_page_size,
            max_message_pages_per_conversation=req.max_message_pages_per_conversation,
            target_inbox_ids=set(req.inbox_ids or [settings.adult_inbox_id]),
            min_last_message_at=req.min_last_message_at,
            progress_callback=_set_sync_state,
        )
    except SalesmessageApiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    clear_adult_kpi_caches(settings.database_url)
    return {"ok": True, **stats}


@app.post("/sync/start")
def sync_start(req: HostedSyncRequest) -> dict[str, Any]:
    current = _get_sync_state()
    if current.get("running"):
        return {"ok": True, "started": False, **current}
    _set_sync_state(
        running=True,
        stage="queued",
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        finished_at=None,
        last_error=None,
        last_result=None,
        salesmessage_progress=None,
    )
    worker = threading.Thread(target=_run_hosted_sync, args=(req,), daemon=True)
    worker.start()
    return {"ok": True, "started": True, **_get_sync_state()}


@app.get("/sync/status")
def sync_status() -> dict[str, Any]:
    return {"ok": True, **_get_sync_state()}


@app.post("/sync/daysmart")
def sync_daysmart(req: DaySmartSyncRequest) -> dict[str, Any]:
    client = DaysmartClient(
        client_id=settings.daysmart_api_client_id,
        client_secret=settings.daysmart_api_secret,
        base_url=settings.daysmart_base_url,
    )
    try:
        stats = sync_daysmart_to_unified(
            client=client,
            db_path=settings.database_url,
            max_pages=req.max_pages,
            page_size=req.page_size,
        )
    except DaysmartApiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    detail_stats = {
        window_key: refresh_adult_kpi_daysmart_detail_cache(
            settings.database_url,
            adult_inbox_id=settings.adult_inbox_id,
            window=window_key,
        )
        for window_key in ("this_year", "last_year")
    }
    clear_adult_kpi_caches(settings.database_url)
    return {"ok": True, **stats, "daysmart_details": detail_stats}


@app.post("/sync/daysmart-trial-attendees")
def sync_daysmart_trial_attendees(req: DaySmartTrialAttendeeRefreshRequest) -> dict[str, Any]:
    stats = {"ok": True, "skipped": True, "reason": "using persisted DaySmart trial registrations"}
    if req.refresh_registrations:
        stats = refresh_daysmart_trial_attendee_source(
            settings.database_url,
            days=req.days,
            window=req.window,
            page_size=req.page_size,
        )
    recent_stats = {"ok": True, "skipped": True}
    if req.refresh_recent_registrations:
        recent_stats = refresh_recent_daysmart_trial_registrations(
            settings.database_url,
            page_size=req.page_size,
            max_pages=8,
        )
        recent_team_stats = refresh_recent_known_trial_team_registrations(
            settings.database_url,
            page_size=req.page_size,
            max_pages=12,
        )
        recent_stats = {"event_registrations": recent_stats, "team_registrations": recent_team_stats}
    historical_stats = {"ok": True, "skipped": True}
    if req.refresh_historical_registrations:
        historical_stats = refresh_historical_known_trial_team_registrations(
            settings.database_url,
            page_size=req.page_size,
        )
    checkin_stats = refresh_daysmart_trial_checkin_history(
        settings.database_url,
        days=req.days,
        window=req.window,
        force_live=req.force_checkins,
    )
    if req.refresh_historical_packs:
        pack_stats = refresh_historical_daysmart_trial_pack_cache(
            settings.database_url,
            page_size=req.page_size,
        )
        spend_stats = refresh_historical_daysmart_trial_spend_cache(
            settings.database_url,
            page_size=req.page_size,
        )
    else:
        pack_stats = refresh_recent_daysmart_trial_pack_cache(settings.database_url, days_back=45)
        spend_stats = refresh_recent_daysmart_trial_spend_cache(settings.database_url, days_back=90)
    return {
        "ok": True,
        "registrations": stats,
        "recent_registrations": recent_stats,
        "historical_registrations": historical_stats,
        "checkins": checkin_stats,
        "packs": pack_stats,
        "spend": spend_stats,
    }


@app.get("/dashboard/summary")
def dashboard_summary() -> dict[str, Any]:
    with get_conn(settings.database_url) as conn:
        conversations = conn.execute(
            "SELECT count(*) AS c FROM conversations WHERE inbox_id = ?",
            (settings.adult_inbox_id,),
        ).fetchone()["c"]
        customers = conn.execute("SELECT count(*) AS c FROM daysmart_customers").fetchone()["c"]
        registrations = conn.execute("SELECT count(*) AS c FROM daysmart_class_registrations").fetchone()["c"]
        memberships = conn.execute("SELECT count(*) AS c FROM daysmart_memberships").fetchone()["c"]
    return {
        "counts": {
            "adult_conversations": conversations,
            "daysmart_customers": customers,
            "class_registrations": registrations,
            "memberships": memberships,
        }
    }


@app.get("/dashboard/adult-kpis")
def dashboard_adult_kpis(
    days: int = 7,
    window: str | None = None,
    detail_level: str = "full",
    refresh: bool = False,
) -> dict[str, Any]:
    return build_adult_kpi_dashboard(
        settings.database_url,
        adult_inbox_id=settings.adult_inbox_id,
        days=days,
        window=window,
        detail_level=detail_level,
        refresh=refresh,
    )


@app.get("/dashboard/adult-kpis/timeseries")
def dashboard_adult_kpis_timeseries(
    days: int = 7,
    window: str | None = None,
    granularity: str = "week",
    refresh: bool = False,
) -> dict[str, Any]:
    return build_adult_kpi_timeseries(
        settings.database_url,
        adult_inbox_id=settings.adult_inbox_id,
        days=days,
        window=window,
        granularity=granularity,
        refresh=refresh,
    )


@app.get("/dashboard/daysmart-trial-kpis")
def dashboard_daysmart_trial_kpis(
    days: int = 7,
    window: str | None = None,
    detail_level: str = "full",
    refresh: bool = False,
) -> dict[str, Any]:
    return build_daysmart_trial_kpi_dashboard(
        settings.database_url,
        days=days,
        window=window,
        detail_level=detail_level,
        refresh=refresh,
    )


@app.get("/dashboard/daysmart-trial-kpis/timeseries")
def dashboard_daysmart_trial_kpis_timeseries(
    days: int = 7,
    window: str | None = None,
    granularity: str = "week",
    refresh: bool = False,
) -> dict[str, Any]:
    return build_daysmart_trial_kpi_timeseries(
        settings.database_url,
        days=days,
        window=window,
        granularity=granularity,
        refresh=refresh,
    )


@app.get("/dashboard/adult-kpis/email-preview")
def dashboard_adult_kpi_email_preview(days: int = 7, window: str | None = None) -> dict[str, Any]:
    preview = build_adult_kpi_email_preview(
        settings.database_url,
        adult_inbox_id=settings.adult_inbox_id,
        days=days,
        window=window,
    )
    return {"ok": True, **preview}
