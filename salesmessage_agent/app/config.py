from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    salesmessage_api_token: str
    salesmessage_base_url: str
    database_url: str
    openai_api_key: str | None
    openai_model: str



def get_settings() -> Settings:
    token = os.getenv("SALESMESSAGE_API_TOKEN", "").strip()
    return Settings(
        salesmessage_api_token=token,
        salesmessage_base_url=os.getenv(
            "SALESMESSAGE_BASE_URL", "https://api.dev.salesmessage.com/qa/pub/v2.2"
        ).rstrip("/"),
        database_url=os.getenv("DATABASE_URL", "salesmessage_agent.db"),
        openai_api_key=os.getenv("OPENAI_API_KEY", "").strip() or None,
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip(),
    )
