"""
FastAPI application factory for the generator service.

Endpoints:
  GET  /health    — liveness probe
  POST /trigger   — manual trigger for local testing (background task)

In production the generator runs via the Pub/Sub subscriber started in lifespan().
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import BackgroundTasks, FastAPI

from config import get_settings
from contract.subscriber import subscribe_and_process
from contract.validators import GenerationRequest
from crews.feature_generator.crew import run_feature_generation

log = logging.getLogger(__name__)


def create_app() -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        log.info(
            "Starting Pub/Sub subscriber for project=%s", settings.google_cloud_project
        )
        task = asyncio.create_task(
            asyncio.to_thread(
                subscribe_and_process,
                run_feature_generation,
                project=settings.google_cloud_project,
            )
        )
        log.info("Pub/Sub subscriber started")

        yield

        task.cancel()
        log.info("Pub/Sub subscriber stopped")

    app = FastAPI(title="shopify-ai-generator", version="1.0.0", lifespan=lifespan)

    # ── Routes ──────────────────────────────────────────────────────────────────

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "generator"}

    @app.post("/trigger", status_code=202)
    def trigger(request: GenerationRequest, background_tasks: BackgroundTasks) -> dict:
        """
        Manual HTTP trigger for local testing.
        In production, jobs arrive via Pub/Sub — this endpoint is for dev convenience.
        """
        log.info("Manual trigger for jobId=%s", request.jobId)
        background_tasks.add_task(run_feature_generation, request)
        return {"jobId": request.jobId, "status": "queued"}

    return app
