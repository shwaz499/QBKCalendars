from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from .analysis import answer_locally, answer_with_llm, get_recent_messages, search_messages
from .config import get_settings
from .db import get_conn, init_db
from .ingest import sync_conversations
from .salesmessage import SalesmessageApiError, SalesmessageClient

settings = get_settings()
init_db(settings.database_url)

mcp = FastMCP("salesmessage-agent")


def _load_context(
    question: str,
    search_query: str | None,
    conversation_id: int | None,
    max_context_messages: int,
) -> list[dict[str, Any]]:
    query = search_query or question
    context = []
    try:
        context = search_messages(
            db_path=settings.database_url,
            query=query,
            limit=max_context_messages,
            conversation_id=conversation_id,
        )
    except Exception:
        context = []

    if not context:
        context = get_recent_messages(
            db_path=settings.database_url,
            limit=max_context_messages,
            conversation_id=conversation_id,
        )
    return context


@mcp.tool()
def sync_salesmessage(
    filters: list[str] | None = None,
    conversation_page_size: int = 100,
    message_page_size: int = 100,
) -> dict[str, Any]:
    """Sync conversations and messages from Salesmessage into local DB."""
    client = SalesmessageClient(
        token=settings.salesmessage_api_token,
        base_url=settings.salesmessage_base_url,
    )
    try:
        stats = sync_conversations(
            client=client,
            db_path=settings.database_url,
            filters=filters or ["open", "closed", "unread", "assigned", "unassigned"],
            conv_page_size=conversation_page_size,
            message_page_size=message_page_size,
        )
    except SalesmessageApiError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, **stats}


@mcp.tool()
def list_conversations(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List conversations already synced into the local database."""
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


@mcp.tool()
def get_conversation_messages(conversation_id: int, limit: int = 200) -> dict[str, Any]:
    """Get messages for one synced conversation."""
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


@mcp.tool()
def search_synced_messages(
    query: str,
    conversation_id: int | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    """Full-text search over synced message bodies."""
    try:
        items = search_messages(
            db_path=settings.database_url,
            query=query,
            limit=limit,
            conversation_id=conversation_id,
        )
    except Exception as exc:
        return {"ok": False, "error": f"Search failed: {exc}", "items": []}
    return {"ok": True, "items": items}


@mcp.tool()
def ask_salesmessage(
    question: str,
    search_query: str | None = None,
    conversation_id: int | None = None,
    max_context_messages: int = 30,
) -> dict[str, Any]:
    """Answer a question from synced data, with local fallback when LLM is unavailable."""
    context = _load_context(
        question=question,
        search_query=search_query,
        conversation_id=conversation_id,
        max_context_messages=max_context_messages,
    )

    if not settings.openai_api_key:
        result = answer_locally(question, context)
        result["context_size"] = len(context)
        return result

    try:
        result = answer_with_llm(
            api_key=settings.openai_api_key,
            model=settings.openai_model,
            question=question,
            context_rows=context,
        )
    except Exception as exc:
        result = answer_locally(question, context)
        result.setdefault("uncertainties", []).append(f"LLM unavailable: {exc}")

    result["context_size"] = len(context)
    return result


if __name__ == "__main__":
    mcp.run()
