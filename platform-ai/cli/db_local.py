"""
db_local.py — persist chat_local generation results into the local Docker postgres
and fake-GCS, mirroring what the platform API does via the Pub/Sub subscriber.

Tenant constants are hardcoded to the single local dev tenant
(hadad747teststore.myshopify.com).  NOT for use in production generator code.
"""
from __future__ import annotations

import json
import random
import re
import string
import time
import urllib.parse
from contextlib import contextmanager
from typing import Any, Dict, Tuple

import psycopg2
import requests

# ── Local dev constants ────────────────────────────────────────────────────────

_TENANT_ID         = "aafb09ec-a15d-48ba-91e7-a02be96a4d3e"
_SHOPIFY_CLIENT_ID = "a2f831d9652fdb7ef86829111ac4a70e"
_SHOP_DOMAIN       = "hadad747teststore.myshopify.com"

_DSN = (
    "host=localhost port=5432 dbname=new_one_two "
    "user=new_one_two_u password=paas_dev_password"
)

_GCS_BASE    = "http://localhost:4443"
_GCS_BUCKET  = "new-one-two-bundles-dev"


# ── Helpers ────────────────────────────────────────────────────────────────────


@contextmanager
def _conn():
    conn = psycopg2.connect(_DSN)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _rand(n: int = 4) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _archetype_from_bundle(bundle: Dict[str, Any]) -> str:
    has_widget = bundle.get("widgetModule") is not None
    has_admin  = bundle.get("adminUiModule") is not None
    if has_widget and has_admin:
        return "storefront_backend_admin"
    if has_admin:
        return "backend_admin"
    if has_widget:
        return "storefront_backend"
    return "backend"


def _upload_bundle_to_gcs(job_id: str, bundle: Dict[str, Any]) -> str:
    """Upload bundle JSON to fake-GCS and return the GCS path."""
    obj_name = f"{job_id}/bundle.json"
    encoded  = urllib.parse.quote(obj_name, safe="")
    url      = f"{_GCS_BASE}/upload/storage/v1/b/{_GCS_BUCKET}/o?uploadType=media&name={encoded}"
    resp = requests.post(
        url,
        data=json.dumps(bundle),
        headers={"Content-Type": "application/json"},
        timeout=10,
    )
    resp.raise_for_status()
    return obj_name


def _upload_js_to_gcs(app_id: str, widget_js: str | None, admin_js: str | None) -> None:
    """Upload rendered widget.js / admin.js to fake-GCS."""
    for name, content in [("widget.js", widget_js), ("admin.js", admin_js)]:
        if not content:
            continue
        obj_name = f"{app_id}/{name}"
        encoded  = urllib.parse.quote(obj_name, safe="")
        url      = f"{_GCS_BASE}/upload/storage/v1/b/{_GCS_BUCKET}/o?uploadType=media&name={encoded}"
        requests.post(
            url,
            data=content.encode(),
            headers={"Content-Type": "application/javascript"},
            timeout=10,
        ).raise_for_status()


# ── Public API ─────────────────────────────────────────────────────────────────


def create_app(name: str) -> Tuple[str, str]:
    """
    Insert a new app row for the local dev tenant.
    archetype starts as 'backend' and is corrected once the bundle is stored.
    Returns (app_id, slug).
    """
    ts   = int(time.time() * 1000)
    slug = f"local-{ts}-{_rand()}"

    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO apps
              (tenant_id, slug, name, status,
               shopify_client_id, shopify_secret_name, shop_domain, app_archetype)
            VALUES (%s, %s, %s, 'draft', %s, '', %s, 'backend')
            RETURNING id
            """,
            (_TENANT_ID, slug, name, _SHOPIFY_CLIENT_ID, _SHOP_DOMAIN),
        )
        app_id = str(cur.fetchone()[0])

    return app_id, slug


def create_session(app_id: str, prompt: str, job_id: str) -> str:
    """
    Create a pending generation row. Mirrors createPendingGeneration in
    platform-back (apps/api/src/routes/generation.ts → packages/db/src/
    generations.ts). `prompt` is persisted so the dashboard's Sessions list
    and chat-rehydrate-on-reload paths can render without pulling the
    bundle from GCS. Returns job_id (same as input — kept for caller
    compatibility).
    """
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO generations (job_id, tenant_id, app_id, status, prompt)
            VALUES (%s::uuid, %s, %s, 'pending', %s)
            ON CONFLICT (job_id) DO NOTHING
            """,
            (job_id, _TENANT_ID, app_id, prompt),
        )
    return job_id


def store_bundle(job_id: str, app_id: str, bundle: Dict[str, Any]) -> None:
    """
    Persist the completed bundle. Mirrors the Pub/Sub subscriber
    (apps/api/src/pubsub/subscriber.ts → upsertGeneration):
      1. Upload full bundle JSON to fake-GCS → store path in generations.
      2. Upload widget.js / admin.js to fake-GCS (for storefront serving).
      3. Flatten handlerModule.{webhookTopics,cronSchedule} into their
         dedicated columns so the dashboard can render LatestSessionResult
         and the Sessions list without pulling the bundle back from GCS.
      4. Update app archetype and status.
    """
    archetype  = _archetype_from_bundle(bundle)
    gcs_path   = _upload_bundle_to_gcs(job_id, bundle)
    widget_js  = bundle.get("widgetModule")
    admin_js   = bundle.get("adminUiModule")
    _upload_js_to_gcs(app_id, widget_js, admin_js)

    handler_module = bundle.get("handlerModule") or {}
    raw_topics = handler_module.get("webhookTopics") or []
    webhook_topics = [t for t in raw_topics if isinstance(t, str)]
    cron_schedule = handler_module.get("cronSchedule")

    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE generations
            SET bundle_gcs_path = %s,
                status          = 'success',
                webhook_topics  = %s::jsonb,
                cron_schedule   = %s,
                updated_at      = NOW()
            WHERE job_id = %s::uuid
            """,
            (gcs_path, json.dumps(webhook_topics), cron_schedule, job_id),
        )
        cur.execute(
            """
            UPDATE apps
            SET app_archetype = %s, status = 'ready', updated_at = NOW()
            WHERE id = %s::uuid
            """,
            (archetype, app_id),
        )


def mark_session_failed(job_id: str, app_id: str, error: str) -> None:
    """Flip generation to failed and app back to draft on generation error."""
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE generations
            SET status = 'failed', error = %s, updated_at = NOW()
            WHERE job_id = %s::uuid
            """,
            (error, job_id),
        )
        cur.execute(
            """
            UPDATE apps SET status = 'draft', updated_at = NOW()
            WHERE id = %s::uuid
            """,
            (app_id,),
        )
