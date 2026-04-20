"""
db_local.py — persist chat_local generation results into the local Docker postgres,
mirroring what the platform API does in generation.ts.

Tenant constants are hardcoded to the single local dev tenant
(hadad747teststore.myshopify.com).  NOT for use in production generator code.
"""
from __future__ import annotations

import json
import random
import re
import string
import time
from contextlib import contextmanager
from typing import Any, Dict, Tuple

import psycopg2

# ── Local dev constants ────────────────────────────────────────────────────────
# Match the single row in the local docker-compose postgres.

_TENANT_ID         = "e5761282-0eaf-419c-bdf8-eb131e1ba406"
_SHOPIFY_CLIENT_ID = "a2f831d9652fdb7ef86829111ac4a70e"
_SHOP_DOMAIN       = "hadad747teststore.myshopify.com"

_DSN = (
    "host=localhost port=5432 dbname=new_one_two "
    "user=new_one_two_u password=paas_dev_password"
)


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
    Create a generation_session in 'running' state.
    Mirrors createGenerationSession + updateGenerationSession in generation.ts.
    Returns session_id.
    """
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO generation_sessions
              (app_id, tenant_id, prompt, status, job_id)
            VALUES (%s, %s, %s, 'running', %s::uuid)
            RETURNING id
            """,
            (app_id, _TENANT_ID, prompt, job_id),
        )
        return str(cur.fetchone()[0])


def store_bundle(job_id: str, app_id: str, bundle: Dict[str, Any]) -> None:
    """
    Persist the completed bundle and transition app to 'ready'.
    Mirrors storeBundleInSession + updateAppArchetype + updateAppStatus in generation.ts.
    """
    archetype = _archetype_from_bundle(bundle)

    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE generation_sessions
            SET bundle = %s::jsonb, status = 'completed', updated_at = NOW()
            WHERE job_id = %s::uuid
            """,
            (json.dumps(bundle), job_id),
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
    """Flip session to failed and app back to draft on generation error."""
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE generation_sessions
            SET status = 'failed', error_message = %s, updated_at = NOW()
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
