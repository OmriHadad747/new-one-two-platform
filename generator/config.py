from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Uvicorn ────────────────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8001
    log_level: str = "info"
    reload: bool = False

    # ── GCP / Pub/Sub ──────────────────────────────────────────────────────────
    google_cloud_project: str = "local"
    pubsub_emulator_host: str = ""

    # ── LLM ───────────────────────────────────────────────────────────────────
    anthropic_api_key: str
    llm_model: str = "claude-haiku-4-5-20251001"
    llm_model_code: str = "claude-sonnet-4-6"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
