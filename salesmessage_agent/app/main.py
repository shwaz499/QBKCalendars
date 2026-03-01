from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .analysis import answer_locally, answer_with_llm, get_recent_messages, search_messages
from .config import get_settings
from .db import get_conn, init_db
from .ingest import sync_conversations
from .salesmessage import SalesmessageApiError, SalesmessageClient

app = FastAPI(title="Salesmessage AI Agent", version="0.1.0")
settings = get_settings()
init_db(settings.database_url)
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


class SyncRequest(BaseModel):
    filters: list[str] = Field(
        default_factory=lambda: ["open", "closed", "unread", "assigned", "unassigned"]
    )
    conversation_page_size: int = 100
    message_page_size: int = 100


class AskRequest(BaseModel):
    question: str
    search_query: str | None = None
    conversation_id: int | None = None
    max_context_messages: int = 30


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def ui() -> FileResponse:
    return FileResponse(static_dir / "index.html")


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
        )
    except SalesmessageApiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, **stats}


@app.get("/conversations")
def list_conversations(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    with get_conn(settings.database_url) as conn:
        rows = conn.execute(
            """
            SELECT id, contact_name, contact_number, started_at, closed_at, last_message_at
            FROM conversations
            ORDER BY coalesce(last_message_at, '') DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


@app.get("/conversations/{conversation_id}/messages")
def list_messages(conversation_id: int, limit: int = 200) -> dict[str, Any]:
    with get_conn(settings.database_url) as conn:
        rows = conn.execute(
            """
            SELECT id, conversation_id, body, status, message_type, source, created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY coalesce(created_at, '') ASC
            LIMIT ?
            """,
            (conversation_id, limit),
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


@app.get("/search")
def search(query: str, conversation_id: int | None = None, limit: int = 25) -> dict[str, Any]:
    try:
        items = search_messages(
            db_path=settings.database_url,
            query=query,
            limit=limit,
            conversation_id=conversation_id,
        )
    except Exception as exc:  # FTS parser can throw on invalid syntax.
        raise HTTPException(status_code=400, detail=f"Search failed: {exc}") from exc
    return {"items": items}


@app.post("/ask")
def ask(req: AskRequest) -> dict[str, Any]:
    query = req.search_query or req.question
    context = []
    try:
        context = search_messages(
            db_path=settings.database_url,
            query=query,
            limit=req.max_context_messages,
            conversation_id=req.conversation_id,
        )
    except Exception:
        context = []

    if not context:
        context = get_recent_messages(
            db_path=settings.database_url,
            limit=req.max_context_messages,
            conversation_id=req.conversation_id,
        )

    if not settings.openai_api_key:
        result = answer_locally(req.question, context)
        result["context_size"] = len(context)
        return result

    try:
        result = answer_with_llm(
            api_key=settings.openai_api_key,
            model=settings.openai_model,
            question=req.question,
            context_rows=context,
        )
    except Exception as exc:
        result = answer_locally(req.question, context)
        result.setdefault("uncertainties", []).append(f"LLM unavailable: {exc}")
    result["context_size"] = len(context)
    return result
