"""
Entrypoint — reads settings from .env via pydantic-settings and runs uvicorn.
"""

from __future__ import annotations

import logging

import uvicorn

from config import get_settings

settings = get_settings()

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

if __name__ == "__main__":
    uvicorn.run(
        "api.server:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        reload=settings.reload,
    )
