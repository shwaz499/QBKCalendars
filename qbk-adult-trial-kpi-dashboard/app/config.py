from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import tomllib

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    salesmessage_api_token: str
    salesmessage_base_url: str
    adult_inbox_id: int
    daysmart_api_client_id: str
    daysmart_api_secret: str
    daysmart_base_url: str
    daysmart_company: str
    database_url: str
    openai_api_key: str | None
    openai_model: str
    eventbrite_sales_csv_path: str


def _load_codex_mcp_env(server_name: str) -> dict[str, str]:
    config_path = Path.home() / ".codex" / "config.toml"
    if not config_path.exists():
        return {}
    try:
        data = tomllib.loads(config_path.read_text())
    except Exception:
        return {}
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict):
        return {}
    server = servers.get(server_name)
    if not isinstance(server, dict):
        return {}
    env = server.get("env")
    if not isinstance(env, dict):
        return {}
    return {str(k): str(v) for k, v in env.items()}


def _salesmessage_api_token() -> str:
    salesmessage_env = _load_codex_mcp_env("salesmessage-agent")
    return (
        salesmessage_env.get("SALESMESSAGE_API_TOKEN", "").strip()
        or salesmessage_env.get("Token", "").strip()
        or os.getenv("SALESMESSAGE_API_TOKEN", "").strip()
    )



def get_settings() -> Settings:
    qbk_env = _load_codex_mcp_env("qbk-sports-admin")
    return Settings(
        salesmessage_api_token=_salesmessage_api_token(),
        salesmessage_base_url=os.getenv(
            "SALESMESSAGE_BASE_URL", "https://api.salesmessage.com/pub/v2.2"
        ).rstrip("/"),
        adult_inbox_id=int(os.getenv("ADULT_INBOX_ID", "80809").strip() or "80809"),
        daysmart_api_client_id=os.getenv("DASH_API_CLIENT_ID", "").strip()
        or qbk_env.get("DASH_API_CLIENT_ID", "").strip(),
        daysmart_api_secret=os.getenv("DASH_API_SECRET", "").strip()
        or qbk_env.get("DASH_API_SECRET", "").strip(),
        daysmart_base_url=os.getenv("DASH_API_BASE_URL", "https://api.dashplatform.com").rstrip("/"),
        daysmart_company=os.getenv("DAYSMART_COMPANY", "qbksports").strip() or "qbksports",
        database_url=os.getenv("DATABASE_URL", "adult_kpi.db"),
        openai_api_key=os.getenv("OPENAI_API_KEY", "").strip() or None,
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip(),
        eventbrite_sales_csv_path=os.getenv(
            "EVENTBRITE_SALES_CSV_PATH",
            "data/eventbrite_adult_sales_latest.csv",
        ).strip()
        or "data/eventbrite_adult_sales_latest.csv",
    )
