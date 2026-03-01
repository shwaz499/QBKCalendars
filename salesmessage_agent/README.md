# Salesmessage AI Agent (Starter)

This starter ingests Salesmessage conversations/messages into a local SQLite DB and exposes APIs for search + AI Q&A.

## Features

- Sync conversations from Salesmessage API (`/sync`)
- Store normalized data in SQLite
- Full-text search over message bodies (`/search`)
- Q&A endpoint with citations (`/ask`), powered by OpenAI Responses API

## Setup

1. Create a virtual environment and install dependencies:

```bash
cd salesmessage_agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Create `.env` from `.env.example` and set values:

```bash
cp .env.example .env
```

Required values:

- `SALESMESSAGE_API_TOKEN`: your Salesmessage bearer token
- `SALESMESSAGE_BASE_URL`: API base URL (default is QA v2.2 from docs)
- `OPENAI_API_KEY`: needed for `/ask` AI answers

3. Run API server:

```bash
uvicorn app.main:app --reload --port 8000
```

## API

- `GET /health`
- `POST /sync`
- `GET /conversations`
- `GET /conversations/{conversation_id}/messages`
- `GET /search?query=your+query`
- `POST /ask`

### Example sync request

```bash
curl -X POST http://localhost:8000/sync \
  -H "Content-Type: application/json" \
  -d '{"filters":["open","closed","unread","assigned","unassigned"]}'
```

### Example ask request

```bash
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What are the top objections in the last messages?","max_context_messages":40}'
```

## Notes

- This starter is intentionally minimal and local-first.
- For production: move to Postgres, add row-level permissions, add audit logs, and schedule incremental sync.

## MCP server mode

You can run this project as an MCP server (stdio transport) and expose tools to any MCP client.

1. Install deps:

```bash
cd salesmessage_agent
source .venv/bin/activate
pip install -r requirements.txt
```

2. Make sure `.env` is configured (`SALESMESSAGE_API_TOKEN` required).

3. Start MCP server:

```bash
python -m app.mcp_server
```

Exposed MCP tools:
- `sync_salesmessage`
- `list_conversations`
- `get_conversation_messages`
- `search_synced_messages`
- `ask_salesmessage`
