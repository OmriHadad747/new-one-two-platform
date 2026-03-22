#!/usr/bin/env bash
# smoke-test.sh — End-to-end pipeline test without calling the real AI generator.
#
# Strategy: start only the infra + Node.js api; skip generator-python entirely.
# After POST /generation, we inject a mock FeatureBundleMessage directly into
# the generation.completed Pub/Sub topic, bypassing LLM calls.
#
# No real credentials needed — everything runs locally in Docker.
#
# Usage:
#   ./scripts/smoke-test.sh          # run and leave services running
#   ./scripts/smoke-test.sh --clean  # tear down all services + volumes when done
#
# Requirements: Docker Desktop, python3, curl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

API_URL="http://localhost:3002"
PUBSUB_URL="http://localhost:8085"
PROJECT="local"

# Fixed UUIDs — seeding is idempotent across reruns
TEST_TENANT_ID="00000000-0000-0000-0000-000000000001"
TEST_APP_ID="00000000-0000-0000-0000-000000000002"

CLEAN_ON_EXIT=false
[[ "${1:-}" == "--clean" ]] && CLEAN_ON_EXIT=true

# ── Colours ───────────────────────────────────────────────────────────────────
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; B='\033[1m'; N='\033[0m'
PASS=0; FAIL=0

pass()    { echo -e "  ${G}✓${N} $1"; PASS=$((PASS + 1)); }
fail()    { echo -e "  ${R}✗${N} $1"; FAIL=$((FAIL + 1)); }
warn()    { echo -e "  ${Y}!${N} $1"; }
section() { echo; echo -e "${B}── $1${N}"; }

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
  if $CLEAN_ON_EXIT; then
    section "Cleanup"
    cd "$ROOT_DIR" && docker compose down -v 2>/dev/null || true
    echo "  Done."
  else
    echo; warn "Services are still running. Stop with: docker compose down"
  fi
}
trap cleanup EXIT

# ── Helpers ───────────────────────────────────────────────────────────────────
# Extract a top-level JSON field: jfield <json_string> <key>
jfield() { python3 -c "import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2],''))" "$1" "$2"; }

# Wait for an HTTP URL to return 2xx (polls every 2s up to max_secs)
wait_for_url() {
  local url=$1 label=$2 max=${3:-90}
  local elapsed=0
  while ! curl -sf "$url" > /dev/null 2>&1; do
    [[ $elapsed -ge $max ]] && { fail "$label not reachable after ${max}s"; return 1; }
    sleep 2; elapsed=$((elapsed + 2))
  done
  pass "$label is up"
}

# Create a Pub/Sub topic or subscription (idempotent — ignores 409 already-exists)
pubsub_put() {
  local path=$1 body=$2
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    "$PUBSUB_URL/v1/projects/$PROJECT/$path" \
    -H "Content-Type: application/json" -d "$body")
  [[ "$HTTP" == "200" || "$HTTP" == "409" ]] && return 0 || return 1
}

echo
echo -e "${B}╔══════════════════════════════════════════════╗${N}"
echo -e "${B}║   Shopify AI-PaaS — Smoke Test (no LLM)     ║${N}"
echo -e "${B}╚══════════════════════════════════════════════╝${N}"

cd "$ROOT_DIR"

# ════════════════════════════════════════════════════════════════════════════════
section "[1] Start infrastructure"
# ════════════════════════════════════════════════════════════════════════════════

# Start dependencies that have healthchecks — --wait blocks until all are healthy
echo "  Starting postgres, redis, fake-gcs, pubsub-emulator (up to 90s)…"
docker compose up -d --wait --wait-timeout 90 \
  postgres redis fake-gcs pubsub-emulator 2>&1 | grep -E "Started|healthy|error" || true

# Verify each individually
for SVC in postgres redis fake-gcs pubsub-emulator; do
  STATUS=$(docker compose ps "$SVC" --format json 2>/dev/null \
    | python3 -c "import json,sys; rows=sys.stdin.read().strip().splitlines(); \
      d=json.loads(rows[0]) if rows else {}; print(d.get('Health','unknown'))" 2>/dev/null || echo "unknown")
  if [[ "$STATUS" == "healthy" ]]; then
    pass "$SVC is healthy"
  else
    fail "$SVC health: $STATUS — run 'docker compose ps' to debug"
  fi
done

# ════════════════════════════════════════════════════════════════════════════════
section "[2] Create Pub/Sub topics + subscriptions"
# ════════════════════════════════════════════════════════════════════════════════
# We create them directly (idempotent) instead of relying on the init container,
# so reruns don't fail due to 409 Already Exists errors.

for TOPIC in "generation.requested" "generation.progress" "generation.completed"; do
  if pubsub_put "topics/$TOPIC" '{}'; then
    pass "Topic '$TOPIC' ready"
  else
    fail "Could not create topic '$TOPIC'"
  fi
done

for SUB in "generator-sub" "api-progress-sub" "api-completed-sub"; do
  case "$SUB" in
    generator-sub)     TOPIC="generation.requested" ;;
    api-progress-sub)  TOPIC="generation.progress" ;;
    api-completed-sub) TOPIC="generation.completed" ;;
  esac
  BODY="{\"topic\":\"projects/$PROJECT/topics/$TOPIC\"}"
  if pubsub_put "subscriptions/$SUB" "$BODY"; then
    pass "Subscription '$SUB' → '$TOPIC' ready"
  else
    fail "Could not create subscription '$SUB'"
  fi
done

# Create the GCS bucket (idempotent — 409 means already exists)
GCS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://localhost:4443/storage/v1/b?project=local" \
  -H "Content-Type: application/json" \
  -d '{"name":"new-one-two-bundles-dev"}')
[[ "$GCS_HTTP" == "200" || "$GCS_HTTP" == "409" ]] \
  && pass "GCS bucket 'new-one-two-bundles-dev' ready" \
  || fail "Could not create GCS bucket (HTTP $GCS_HTTP)"

# ════════════════════════════════════════════════════════════════════════════════
section "[3] Seed DB — test tenant + app"
# ════════════════════════════════════════════════════════════════════════════════

docker compose exec -T postgres psql -U new_one_two_u -d new_one_two -q <<'SQL'
INSERT INTO tenants (id, slug, name, status, plan, kms_key_name)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'smoke-test-tenant',
  'Smoke Test Tenant',
  'active',
  'starter',
  'projects/local/locations/global/keyRings/dev/cryptoKeys/smoke-test'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO apps (
  id, tenant_id, slug, name, status,
  shopify_api_key, shopify_secret_name, shop_domain
) VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'smoke-test-app',
  'Smoke Test App',
  'active',
  'smoke-test-api-key',
  'projects/local/secrets/smoke-test/versions/latest',
  'smoke-test-store.myshopify.com'
) ON CONFLICT (id) DO NOTHING;
SQL
pass "Test tenant + app seeded (idempotent)"

# Sanity check rows exist
TENANT_COUNT=$(docker compose exec -T postgres psql -U new_one_two_u -d new_one_two -tqc \
  "SELECT COUNT(*) FROM tenants WHERE id='00000000-0000-0000-0000-000000000001';" | tr -d '[:space:]')
APP_COUNT=$(docker compose exec -T postgres psql -U new_one_two_u -d new_one_two -tqc \
  "SELECT COUNT(*) FROM apps WHERE id='00000000-0000-0000-0000-000000000002';" | tr -d '[:space:]')
[[ "$TENANT_COUNT" == "1" ]] && pass "Tenant row confirmed in DB" || fail "Tenant row missing from DB"
[[ "$APP_COUNT"    == "1" ]] && pass "App row confirmed in DB"    || fail "App row missing from DB"

# ════════════════════════════════════════════════════════════════════════════════
section "[4] Start Node.js api service"
# ════════════════════════════════════════════════════════════════════════════════

docker compose up -d api 2>&1 | grep -E "Started|Building|error" || true
wait_for_url "$API_URL/health" "api service" 90

HEALTH=$(curl -s "$API_URL/health")
[[ "$(jfield "$HEALTH" "service")" == "api" ]] \
  && pass "api /health → service=api" \
  || fail "api /health unexpected body: $HEALTH"

# ════════════════════════════════════════════════════════════════════════════════
section "[5] POST /generation — create generation session"
# ════════════════════════════════════════════════════════════════════════════════

GEN_RAW=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/generation" \
  -H "Content-Type: application/json" \
  -d "{
    \"appId\":   \"$TEST_APP_ID\",
    \"tenantId\":\"$TEST_TENANT_ID\",
    \"prompt\":  \"Build me a notify me when back in stock feature\",
    \"platformApiCatalog\": [
      {\"method\":\"POST\",\"path\":\"/features/waitlist/signup\"},
      {\"method\":\"GET\", \"path\":\"/features/waitlist/status\"}
    ],
    \"existingFeatures\": []
  }")
GEN_CODE=$(echo "$GEN_RAW" | tail -1)
GEN_BODY=$(echo "$GEN_RAW" | head -1)

if [[ "$GEN_CODE" != "202" ]]; then
  fail "POST /generation returned $GEN_CODE — body: $GEN_BODY"
  warn "Check api logs: docker compose logs api --tail 80"
  exit 1
fi
pass "POST /generation → HTTP 202"

JOB_ID=$(jfield "$GEN_BODY" "jobId")
SESSION_ID=$(jfield "$GEN_BODY" "sessionId")

[[ -n "$JOB_ID"     ]] && pass "jobId:    $JOB_ID"    || { fail "No jobId in response"; exit 1; }
[[ -n "$SESSION_ID" ]] && pass "sessionId: $SESSION_ID" || fail "No sessionId in response"

# ════════════════════════════════════════════════════════════════════════════════
section "[6] Verify GenerationRequest landed in generator-sub"
# ════════════════════════════════════════════════════════════════════════════════

sleep 1   # give Pub/Sub a moment to route the message

PULL=$(curl -s -X POST \
  "$PUBSUB_URL/v1/projects/$PROJECT/subscriptions/generator-sub:pull" \
  -H "Content-Type: application/json" \
  -d '{"maxMessages":1}')

MSG_COUNT=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(len(d.get('receivedMessages',[])))" "$PULL")

if [[ "$MSG_COUNT" -ge 1 ]]; then
  pass "GenerationRequest found in generator-sub (generator-python would consume this)"
  # Ack so it doesn't accumulate across reruns
  ACK_ID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['receivedMessages'][0]['ackId'])" "$PULL")
  curl -s -X POST "$PUBSUB_URL/v1/projects/$PROJECT/subscriptions/generator-sub:acknowledge" \
    -H "Content-Type: application/json" \
    -d "{\"ackIds\":[\"$ACK_ID\"]}" > /dev/null
else
  fail "No message in generator-sub — api may not have published to generation.requested"
  warn "docker compose logs api --tail 80"
fi

# ════════════════════════════════════════════════════════════════════════════════
section "[7] Inject mock FeatureBundleMessage → generation.completed"
# ════════════════════════════════════════════════════════════════════════════════
# This simulates what generator-python would publish after running all 5 agents.

PUBLISH_PAYLOAD=$(python3 - "$JOB_ID" <<'PYEOF'
import json, sys, base64

job_id = sys.argv[1]

bundle_msg = {
  "jobId": job_id,
  "status": "success",
  "bundle": {
    "appBlock": {
      "schema": {
        "name": "Back In Stock Notifier",
        "settings": [
          {"type": "text",  "id": "button_text",     "label": "Button Text",         "default": "Notify Me"},
          {"type": "text",  "id": "success_message",  "label": "Success message",     "default": "You're on the list!"},
          {"type": "color", "id": "button_color",     "label": "Button colour",       "default": "#000000"}
        ]
      },
      "liquid": (
        "<div id='bis-block'>"
        "{% if product.available %}"
          "<p class='bis-available'>In Stock</p>"
        "{% else %}"
          "<form id='bis-form' class='bis-form'>"
            "<input type='email' id='bis-email' name='email' placeholder='your@email.com' required>"
            "<button type='submit' style='background:{{ block.settings.button_color }}'>"
              "{{ block.settings.button_text }}"
            "</button>"
          "</form>"
          "<p id='bis-confirmation' style='display:none'>{{ block.settings.success_message }}</p>"
        "{% endif %}"
        "</div>"
      ),
      "javascript": (
        "(function(){"
          "var form=document.getElementById('bis-form');"
          "if(!form)return;"
          "form.addEventListener('submit',function(e){"
            "e.preventDefault();"
            "var email=document.getElementById('bis-email').value;"
            "fetch('/features/waitlist/signup',{"
              "method:'POST',"
              "headers:{'Content-Type':'application/json'},"
              "body:JSON.stringify({productId:'{{product.id}}',email:email})"
            "}).then(function(){"
              "form.style.display='none';"
              "document.getElementById('bis-confirmation').style.display='block';"
            "});"
          "});"
        "})();"
      )
    },
    "handlerModule": {
      "code": (
        "module.exports = {\n"
        "  webhookTopics: ['inventory_levels/update'],\n"
        "  cronSchedule: null,\n"
        "  handler: async (ctx) => {\n"
        "    const { payload, tenantId, log, db } = ctx;\n"
        "    const entries = await db.query(\n"
        "      'SELECT email, id FROM waitlist_entries WHERE product_id = $1 AND tenant_id = $2',\n"
        "      [String(payload.inventory_item_id), tenantId]\n"
        "    );\n"
        "    log.info({ count: entries.length }, 'Notifying waitlist subscribers');\n"
        "    await db.query(\n"
        "      'UPDATE waitlist_entries SET notified_at = NOW() WHERE product_id = $1 AND tenant_id = $2',\n"
        "      [String(payload.inventory_item_id), tenantId]\n"
        "    );\n"
        "    return { notified: entries.length };\n"
        "  }\n"
        "};"
      ),
      "webhookTopics": ["inventory_levels/update"],
      "cronSchedule": None
    },
    "dbMigration": {
      "sql": (
        "CREATE TABLE waitlist_entries (\n"
        "  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n"
        "  tenant_id  UUID NOT NULL,\n"
        "  product_id VARCHAR(255) NOT NULL,\n"
        "  email      VARCHAR(255) NOT NULL,\n"
        "  notified_at TIMESTAMPTZ,\n"
        "  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n"
        "  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()\n"
        ");\n\n"
        "ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;\n\n"
        "CREATE POLICY waitlist_entries_tenant_isolation ON waitlist_entries\n"
        "  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);\n\n"
        "CREATE INDEX idx_waitlist_tenant ON waitlist_entries (tenant_id);\n"
        "CREATE INDEX idx_waitlist_product ON waitlist_entries (tenant_id, product_id);"
      )
    },
    "explanation": {
      "merchantFacing": (
        "This feature adds a 'Notify Me' button on product pages when items are out of stock. "
        "Customers enter their email to join a waitlist. When you restock the item, they are "
        "automatically notified so they can return and complete their purchase."
      ),
      "technical": {
        "webhookTopics": ["inventory_levels/update"],
        "dbTables": ["waitlist_entries"],
        "estimatedMonthlyExecutions": 200,
        "estimatedMonthlyCost": "$0.002"
      }
    }
  },
  "meta": {
    "totalInputTokens": 0,
    "totalOutputTokens": 0,
    "generationMs": 0,
    "agentTrace": []
  }
}

data_b64 = base64.b64encode(json.dumps(bundle_msg).encode()).decode()
print(json.dumps({
  "messages": [{
    "data": data_b64,
    "attributes": {"jobId": job_id, "status": "success"}
  }]
}))
PYEOF
)

PUB_RESP=$(curl -s -X POST \
  "$PUBSUB_URL/v1/projects/$PROJECT/topics/generation.completed:publish" \
  -H "Content-Type: application/json" \
  -d "$PUBLISH_PAYLOAD")

MSG_IDS=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(','.join(d.get('messageIds',[])))" "$PUB_RESP")
[[ -n "$MSG_IDS" ]] \
  && pass "Mock bundle published to generation.completed (msgId: $MSG_IDS)" \
  || fail "Failed to publish mock bundle — response: $PUB_RESP"

# ════════════════════════════════════════════════════════════════════════════════
section "[8] Poll GET /generation/:jobId/result until bundle is in DB"
# ════════════════════════════════════════════════════════════════════════════════

FOUND=false
for i in $(seq 1 15); do
  RES_RAW=$(curl -s -w "\n%{http_code}" "$API_URL/generation/$JOB_ID/result")
  RES_CODE=$(echo "$RES_RAW" | tail -1)
  RES_BODY=$(echo "$RES_RAW" | head -1)
  RES_STATUS=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('status',''))" "$RES_BODY" 2>/dev/null || echo "")

  if [[ "$RES_CODE" == "200" && "$RES_STATUS" == "success" ]]; then
    pass "Bundle in DB after ${i}s (HTTP 200, status=success)"
    FOUND=true

    # Check all four required fields
    FIELDS=$(python3 -c "
import json, sys
b = json.loads(sys.argv[1]).get('bundle', {})
missing = [f for f in ['appBlock','handlerModule','dbMigration','explanation'] if f not in b]
print('missing:' + ','.join(missing) if missing else 'ok')
" "$RES_BODY")
    [[ "$FIELDS" == "ok" ]] \
      && pass "Bundle has all fields: appBlock, handlerModule, dbMigration, explanation" \
      || fail "Bundle missing fields: $FIELDS"

    DB_TABLES=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
tables = d.get('bundle',{}).get('explanation',{}).get('technical',{}).get('dbTables',[])
print(', '.join(tables))
" "$RES_BODY")
    pass "DB tables reported: [$DB_TABLES]"
    break
  fi

  if [[ "$RES_CODE" == "422" ]]; then
    fail "Generation reported failed — $(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('error',''))" "$RES_BODY")"
    break
  fi

  sleep 1
done

$FOUND || fail "Bundle not persisted to DB within 15s (last: HTTP $RES_CODE, status=$RES_STATUS)"

# ════════════════════════════════════════════════════════════════════════════════
section "[9] Edge cases"
# ════════════════════════════════════════════════════════════════════════════════

# Unknown jobId → 404
CODE_404=$(curl -s -o /dev/null -w "%{http_code}" \
  "$API_URL/generation/00000000-0000-0000-0000-999999999999/result")
[[ "$CODE_404" == "404" ]] \
  && pass "Unknown jobId returns 404" \
  || fail "Unknown jobId returned $CODE_404 (expected 404)"

# Missing required fields → 400
CODE_400=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/generation" \
  -H "Content-Type: application/json" \
  -d '{"appId":"missing-tenant"}')
[[ "$CODE_400" == "400" ]] \
  && pass "Missing tenantId/prompt returns 400" \
  || fail "Missing fields returned $CODE_400 (expected 400)"

# SSE endpoint reachable
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 \
  "$API_URL/generation/$JOB_ID/progress" 2>/dev/null) || true
[[ "$SSE_CODE" == "200" || "$SSE_CODE" == "000" ]] \
  && pass "SSE endpoint /generation/:jobId/progress is reachable" \
  || fail "SSE endpoint returned $SSE_CODE"

# ════════════════════════════════════════════════════════════════════════════════
echo
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
printf "${B}  Results:${N} ${G}%d passed${N}  ${R}%d failed${N}\n" "$PASS" "$FAIL"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo

if [[ $FAIL -gt 0 ]]; then
  echo -e "${R}Smoke test FAILED.${N}"
  echo "  Useful commands:"
  echo "    docker compose logs api            --tail 100"
  echo "    docker compose logs pubsub-emulator --tail 50"
  echo "    docker compose ps"
  exit 1
fi

echo -e "${G}All checks passed.${N}"
echo
echo "Next:"
echo "  Real LLM generation:  export ANTHROPIC_API_KEY=sk-ant-... && docker compose up"
echo "  Trigger generation:   curl -X POST http://localhost:3002/generation -H 'Content-Type: application/json' -d '{\"appId\":\"$TEST_APP_ID\",\"tenantId\":\"$TEST_TENANT_ID\",\"prompt\":\"back in stock notifier\",\"existingFeatures\":[]}'"
echo "  Watch progress (SSE): curl -N http://localhost:3002/generation/<jobId>/progress"
echo "  Full guide:           cat INSTRUCTIONS.md"
