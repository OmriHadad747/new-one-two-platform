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

    # ── Feature flags ──────────────────────────────────────────────────────────
    # LLM_VALIDATION_ENABLED=true  →  run semantic alignment check after static
    # validation passes. On HIGH-confidence failure, triggers one revision pass.
    llm_validation_enabled: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
