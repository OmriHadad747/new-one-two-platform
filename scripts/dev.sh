#!/usr/bin/env bash
# dev.sh — Full local dev cycle:
#   1. docker compose down -v
#   2. Start infra (postgres, redis, fake-gcs, pubsub-emulator, bull-board)
#   3. Start platform services (pnpm dev) + Python generator in background
#   4. Create tenant + app via API
#   5. POST /generation
#   6. Poll GET /generation/:jobId/result until complete  ← this is how we know when to approve
#   7. POST /generation/:jobId/approve
#
# Usage:
#   ./scripts/dev.sh
#   ./scripts/dev.sh --prompt "Build me a loyalty points feature"
#
# Requirements: Docker Desktop, pnpm, python3, generator/.env with ANTHROPIC_API_KEY,
#               platform/.env with KMS_DEV_KEY (see INSTRUCTIONS.md Phase B)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$ROOT_DIR/.dev-logs"
mkdir -p "$LOGS_DIR"

API_URL="http://localhost:3002"
GENERATOR_URL="http://localhost:8001"

# Fixed UUIDs — idempotent across reruns
TENANT_ID="00000000-0000-0000-0000-000000000001"
APP_ID="00000000-0000-0000-0000-000000000002"

PROMPT="Build me a notify me when back in stock feature"

while [[ $# -gt 0 ]]; do
  case $1 in
    --prompt) PROMPT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# PIDs of background services
PLATFORM_PID=""
GENERATOR_PID=""

# ── Colors ────────────────────────────────────────────────────────────────────
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; B='\033[1m'; N='\033[0m'

log()     { echo -e "${B}▶${N} $*"; }
ok()      { echo -e "  ${G}✓${N} $*"; }
err()     { echo -e "  ${R}✗${N} $*"; }
warn()    { echo -e "  ${Y}!${N} $*"; }
section() { echo; echo -e "${B}══ $* ══${N}"; }

# ── Cleanup ───────────────────────────────────────────────────────────────────
# On Ctrl+C or error: kill background services.
# On clean exit: leave them running (user may want to interact).
SCRIPT_SUCCEEDED=false

cleanup() {
  if ! $SCRIPT_SUCCEEDED; then
    echo
    log "Interrupted — stopping background services..."
    [[ -n "$PLATFORM_PID"  ]] && kill "$PLATFORM_PID"  2>/dev/null || true
    [[ -n "$GENERATOR_PID" ]] && kill "$GENERATOR_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    echo "  Stopped. Logs in $LOGS_DIR/"
  fi
}
trap cleanup EXIT

# ── Helpers ───────────────────────────────────────────────────────────────────
jfield() {
  python3 -c "import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2],''))" "$1" "$2"
}

json_encode() {
  python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$1"
}

wait_for_url() {
  local url=$1 label=$2 max=${3:-120}
  local elapsed=0
  printf "  Waiting for %s" "$label"
  while ! curl -sf "$url" > /dev/null 2>&1; do
    if [[ $elapsed -ge $max ]]; then
      echo
      err "$label not reachable after ${max}s"
      return 1
    fi
    sleep 2; elapsed=$((elapsed + 2))
    printf "."
  done
  echo
  ok "$label is up"
}

# ════════════════════════════════════════════════════════════════════════════════
echo
echo -e "${B}╔════════════════════════════════════════════════╗${N}"
echo -e "${B}║   new-one-two — local dev run                  ║${N}"
echo -e "${B}╚════════════════════════════════════════════════╝${N}"
echo "  Prompt: $PROMPT"

# ════════════════════════════════════════════════════════════════════════════════
section "1. Tear down existing stack"
# ════════════════════════════════════════════════════════════════════════════════

cd "$ROOT_DIR"
log "docker compose down -v"
docker compose down -v 2>&1 | grep -E "Removed|Stopped|error" || true
ok "Clean slate"

# ════════════════════════════════════════════════════════════════════════════════
section "2. Start infra"
# ════════════════════════════════════════════════════════════════════════════════

log "Starting infra (postgres, redis, fake-gcs, pubsub-emulator, init containers, bull-board)..."
docker compose up -d --wait --wait-timeout 120 \
  postgres redis fake-gcs pubsub-emulator pubsub-init bull-board 2>&1 \
  | grep -E "Started|Healthy|error" || true

ok "Infra ready — Bull Board: http://localhost:3010"

# Wait until pubsub-init has actually created the subscription
log "Waiting for Pub/Sub subscriptions to be ready..."
PUBSUB_URL="http://localhost:8085/v1/projects/local/subscriptions/generator-sub"
elapsed=0
while ! curl -sf "$PUBSUB_URL" > /dev/null 2>&1; do
  if [[ $elapsed -ge 60 ]]; then
    err "Pub/Sub subscription generator-sub not ready after 60s"
    exit 1
  fi
  sleep 2; elapsed=$((elapsed + 2))
done
ok "Pub/Sub subscriptions ready"

# ════════════════════════════════════════════════════════════════════════════════
section "3. Start application services"
# ════════════════════════════════════════════════════════════════════════════════

# Kill any stale processes left on service ports from previous runs

for PORT in 3001 3002 8001; do
  PIDS=$(lsof -ti :"$PORT" 2>/dev/null) && echo "$PIDS" | xargs kill 2>/dev/null && ok "Cleared port $PORT" || true
done

# Start platform (api + webhook-gateway + worker)
log "Starting platform services (pnpm dev)..."
log "  Log: $LOGS_DIR/platform.txt"
(cd "$ROOT_DIR/platform" && NO_COLOR=1 pnpm dev --filter=!@new-one-two/worker) > "$LOGS_DIR/platform.txt" 2>&1 &
PLATFORM_PID=$!
ok "Platform services starting (PID $PLATFORM_PID)"

# Start Python generator
log "Starting Python generator..."
log "  Log: $LOGS_DIR/generator.txt"
(cd "$ROOT_DIR/generator" && source .venv/bin/activate && set -a && source .env && set +a && NO_COLOR=1 python main.py) \
  > "$LOGS_DIR/generator.txt" 2>&1 &
GENERATOR_PID=$!
ok "Generator starting (PID $GENERATOR_PID)"

# Wait until both are reachable
wait_for_url "$API_URL/health"       "platform API (port 3002)" 120
wait_for_url "$GENERATOR_URL/health" "generator   (port 8001)"  60

# ════════════════════════════════════════════════════════════════════════════════
section "4. Create tenant + app"
# ════════════════════════════════════════════════════════════════════════════════

log "Creating tenant (id: $TENANT_ID)..."
T_RAW=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/tenants" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\":   \"$TENANT_ID\",
    \"slug\": \"dev-tenant\",
    \"name\": \"Dev Tenant\"
  }")
T_CODE=$(echo "$T_RAW" | tail -1)
T_BODY=$(echo "$T_RAW" | head -1)
[[ "$T_CODE" == "201" || "$T_CODE" == "409" ]] \
  && ok "Tenant ready" \
  || { err "POST /tenants → HTTP $T_CODE: $T_BODY"; exit 1; }

log "Creating app (id: $APP_ID)..."
A_RAW=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/tenants/$TENANT_ID/apps" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\":         \"$APP_ID\",
    \"slug\":       \"dev-app\",
    \"name\":       \"Dev App\",
    \"shopDomain\": \"dev-store.myshopify.com\"
  }")
A_CODE=$(echo "$A_RAW" | tail -1)
A_BODY=$(echo "$A_RAW" | head -1)
[[ "$A_CODE" == "201" || "$A_CODE" == "409" ]] \
  && ok "App ready" \
  || { err "POST /tenants/:id/apps → HTTP $A_CODE: $A_BODY"; exit 1; }

# ════════════════════════════════════════════════════════════════════════════════
section "5. Trigger generation"
# ════════════════════════════════════════════════════════════════════════════════

log "Sending generation request..."
GEN_RAW=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/generation" \
  -H "Content-Type: application/json" \
  -d "{
    \"appId\":    \"$APP_ID\",
    \"tenantId\": \"$TENANT_ID\",
    \"prompt\":   $(json_encode "$PROMPT"),
    \"platformApiCatalog\": [
      {\"method\":\"POST\",\"path\":\"/features/waitlist/signup\"},
      {\"method\":\"GET\", \"path\":\"/features/waitlist/status\"}
    ],
    \"existingFeatures\": []
  }")
GEN_CODE=$(echo "$GEN_RAW" | tail -1)
GEN_BODY=$(echo "$GEN_RAW" | head -1)

[[ "$GEN_CODE" == "202" ]] \
  || { err "POST /generation → HTTP $GEN_CODE: $GEN_BODY"; exit 1; }

JOB_ID=$(jfield "$GEN_BODY" "jobId")
[[ -n "$JOB_ID" ]] || { err "No jobId in response: $GEN_BODY"; exit 1; }

ok "Generation started — jobId: $JOB_ID"
echo
echo "  Live progress (open in another terminal):"
echo "    curl -N $API_URL/generation/$JOB_ID/progress"
echo "  Generator logs:"
echo "    tail -f $LOGS_DIR/generator.txt"

# ════════════════════════════════════════════════════════════════════════════════
section "6. Waiting for generation to complete"
# ════════════════════════════════════════════════════════════════════════════════
# Poll GET /generation/:jobId/result every 5s.
# Response status field:
#   "running" → still processing (agents are running)
#   "success" → bundle is ready → proceed to approve
#   "failed"  → generation error → print error and exit

log "Polling every 5s (timeout: 5 min)..."
echo

GEN_STATUS=""
ELAPSED=0
MAX_WAIT=300
INTERVAL=5

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  R_RAW=$(curl -s -w "\n%{http_code}" "$API_URL/generation/$JOB_ID/result")
  R_CODE=$(echo "$R_RAW" | tail -1)
  R_BODY=$(echo "$R_RAW" | head -1)
  GEN_STATUS=$(python3 -c \
    "import json,sys; print(json.loads(sys.argv[1]).get('status',''))" \
    "$R_BODY" 2>/dev/null || echo "")

  case "$GEN_STATUS" in
    success)
      ok "Generation complete after ${ELAPSED}s"
      break
      ;;
    failed)
      GEN_ERR=$(python3 -c \
        "import json,sys; print(json.loads(sys.argv[1]).get('error','unknown'))" \
        "$R_BODY" 2>/dev/null || echo "unknown")
      err "Generation failed: $GEN_ERR"
      warn "Generator logs: tail -f $LOGS_DIR/generator.txt"
      exit 1
      ;;
    running|"")
      printf "  [%3ds] running...\n" "$ELAPSED"
      sleep $INTERVAL
      ELAPSED=$((ELAPSED + INTERVAL))
      ;;
    *)
      printf "  [%3ds] status=%s (HTTP %s)\n" "$ELAPSED" "$GEN_STATUS" "$R_CODE"
      sleep $INTERVAL
      ELAPSED=$((ELAPSED + INTERVAL))
      ;;
  esac
done

if [[ "$GEN_STATUS" != "success" ]]; then
  err "Timed out after ${MAX_WAIT}s (last status: ${GEN_STATUS:-unknown})"
  warn "Generator logs: tail -f $LOGS_DIR/generator.txt"
  exit 1
fi

# ════════════════════════════════════════════════════════════════════════════════
section "7. Approve + deploy"
# ════════════════════════════════════════════════════════════════════════════════

log "Approving $JOB_ID..."
AP_RAW=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/generation/$JOB_ID/approve")
AP_CODE=$(echo "$AP_RAW" | tail -1)
AP_BODY=$(echo "$AP_RAW" | head -1)

[[ "$AP_CODE" == "200" ]] \
  || { err "POST /approve → HTTP $AP_CODE: $AP_BODY"; exit 1; }

DEPLOYED=$(jfield "$AP_BODY" "deployed")
FUNC_URL=$(jfield "$AP_BODY" "functionUrl")
ok "Deployed (deployed=$DEPLOYED)"
[[ -n "$FUNC_URL" ]] && ok "Function URL: $FUNC_URL"

# ════════════════════════════════════════════════════════════════════════════════
SCRIPT_SUCCEEDED=true
echo
echo -e "${G}${B}════════════════════════════════════════════════${N}"
echo -e "${G}${B}  Done! Full cycle completed successfully.      ${N}"
echo -e "${G}${B}════════════════════════════════════════════════${N}"
echo
echo "  jobId:         $JOB_ID"
echo "  tenantId:      $TENANT_ID"
echo "  appId:         $APP_ID"
echo
echo "Useful commands:"
printf "  Result:        curl -s %s/generation/%s/result | python3 -m json.tool\n" "$API_URL" "$JOB_ID"
echo  "  Generator logs: tail -f $LOGS_DIR/generator.txt"
echo  "  Platform logs:  tail -f $LOGS_DIR/platform.txt"
echo  "  Bull Board:     open http://localhost:3010"
echo  "  Stop services:  kill $PLATFORM_PID $GENERATOR_PID"
echo
warn "Background services (PIDs: platform=$PLATFORM_PID generator=$GENERATOR_PID) are still running."
warn "Press Ctrl+C or run the kill command above to stop them."
echo

# Keep the script alive so Ctrl+C triggers cleanup
wait $PLATFORM_PID $GENERATOR_PID 2>/dev/null || true
