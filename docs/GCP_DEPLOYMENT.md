# GCP Production Deployment Guide

Step-by-step instructions to deploy the New One Two Platform to Google Cloud Platform.

---

## Architecture Overview

```
                    ┌─────────────────────────────────────────────┐
                    │                  Internet                    │
                    └────┬──────────┬──────────────┬──────────────┘
                         │          │              │
                    HTTPS (API) HTTPS (Webhooks)  HTTPS (Dashboard)
                         │          │              │
                    ┌────▼───┐ ┌────▼──────────┐  ┌▼──────────────┐
                    │  API   │ │Webhook Gateway│  │ GCS Static    │
                    │Cloud Run│ │  Cloud Run    │  │ (Frontend)    │
                    └──┬──┬──┘ └───────┬───────┘  └───────────────┘
                       │  │            │
               ┌───────┘  │     ┌──────▼──────┐
               │          │     │   Worker     │
       ┌───────▼──┐       │     │  Cloud Run   │
       │ Pub/Sub  │       │     └──────┬───────┘
       │ Topics   │       │            │
       └────┬─────┘       │     ┌──────▼───────┐
            │             │     │   Harness     │
       ┌────▼─────┐       │     │  Cloud Run    │
       │Generator │       │     │ (per-tenant)  │
       │Cloud Run │       │     └──────────────┘
       └──────────┘       │
                    ┌─────▼──────────────────────┐
                    │     Cloud SQL (Postgres)    │
                    │     Memorystore (Redis)     │
                    │     Cloud KMS               │
                    │     Secret Manager          │
                    │     GCS (widget bundles)    │
                    └────────────────────────────┘
```

---

## Prerequisites

- A GCP account with billing enabled
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Docker installed locally (for building images)
- A registered domain with DNS you control

---

## Step 1: Create GCP Project

```bash
export PROJECT_ID=new-one-two-prod   # choose your project ID
export REGION=us-central1

gcloud projects create $PROJECT_ID
gcloud config set project $PROJECT_ID

# Enable billing (do this in the Console if not already done)
# https://console.cloud.google.com/billing
```

## Step 2: Enable Required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  pubsub.googleapis.com \
  cloudkms.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  vpcaccess.googleapis.com \
  compute.googleapis.com
```

## Step 3: Create Artifact Registry Repository

```bash
gcloud artifacts repositories create new-one-two \
  --repository-format=docker \
  --location=$REGION \
  --description="Platform container images"

# Set the registry URL for later use
export REGISTRY=$REGION-docker.pkg.dev/$PROJECT_ID/new-one-two
```

## Step 4: Set Up Networking

Cloud Run services need to reach Cloud SQL and Memorystore via private IP.
Create a VPC connector:

```bash
# Create a VPC connector for Cloud Run → private services
gcloud compute networks vpc-access connectors create platform-connector \
  --region=$REGION \
  --range=10.8.0.0/28

# Note the connector name for Cloud Run deploys:
export VPC_CONNECTOR=projects/$PROJECT_ID/locations/$REGION/connectors/platform-connector
```

## Step 5: Provision Cloud SQL (PostgreSQL 16)

```bash
# Create the instance (adjust tier for your needs)
gcloud sql instances create new-one-two-db \
  --database-version=POSTGRES_16 \
  --tier=db-custom-2-4096 \
  --region=$REGION \
  --storage-size=20GB \
  --storage-auto-increase \
  --availability-type=zonal \
  --enable-point-in-time-recovery \
  --backup-start-time=03:00 \
  --retained-backups-count=7 \
  --network=default \
  --no-assign-ip

# Create database and user
gcloud sql databases create new_one_two --instance=new-one-two-db

# Generate a strong password
export DB_PASSWORD=$(openssl rand -base64 24)
echo "DB_PASSWORD=$DB_PASSWORD"   # SAVE THIS

gcloud sql users create platform_user \
  --instance=new-one-two-db \
  --password=$DB_PASSWORD

# Get the private IP
gcloud sql instances describe new-one-two-db \
  --format="value(ipAddresses[0].ipAddress)"
```

Save the private IP as `$DB_HOST`.

### Run Migrations

```bash
# Install Cloud SQL Proxy locally
gcloud components install cloud-sql-proxy

# Start proxy in a separate terminal
cloud-sql-proxy $PROJECT_ID:$REGION:new-one-two-db --port 5432

# Run all migrations in order
for f in platform/packages/db/migrations/*.sql; do
  echo "Running: $f"
  PGPASSWORD=$DB_PASSWORD psql \
    -h 127.0.0.1 -p 5432 \
    -U platform_user -d new_one_two \
    -f "$f" --set ON_ERROR_STOP=1
done
```

## Step 6: Provision Memorystore (Redis 7)

```bash
gcloud redis instances create new-one-two-redis \
  --size=1 \
  --region=$REGION \
  --redis-version=redis_7_0 \
  --transit-encryption-mode=SERVER_AUTHENTICATION \
  --auth-enabled

# Get connection info
gcloud redis instances describe new-one-two-redis \
  --region=$REGION \
  --format="value(host)"

gcloud redis instances describe new-one-two-redis \
  --region=$REGION \
  --format="value(authString)"
```

Save the host as `$REDIS_HOST` and auth string as `$REDIS_PASSWORD`.

## Step 7: Create Cloud KMS Key

```bash
gcloud kms keyrings create platform-keys --location=$REGION

gcloud kms keys create tenant-secrets \
  --keyring=platform-keys \
  --location=$REGION \
  --purpose=encryption
```

## Step 8: Create Pub/Sub Topics and Subscriptions

```bash
# Topics
gcloud pubsub topics create generation.requested
gcloud pubsub topics create generation.progress
gcloud pubsub topics create generation.completed

# Subscriptions
gcloud pubsub subscriptions create generator-sub \
  --topic=generation.requested \
  --ack-deadline=600

gcloud pubsub subscriptions create api-progress-sub \
  --topic=generation.progress \
  --ack-deadline=30

gcloud pubsub subscriptions create api-completed-sub \
  --topic=generation.completed \
  --ack-deadline=30
```

## Step 9: Create GCS Buckets

```bash
# Widget JS bundles (public read for storefront serving)
gcloud storage buckets create gs://new-one-two-bundles-$PROJECT_ID \
  --location=$REGION \
  --uniform-bucket-level-access

# Make widget objects publicly readable
gcloud storage buckets add-iam-policy-binding \
  gs://new-one-two-bundles-$PROJECT_ID \
  --member=allUsers \
  --role=roles/storage.objectViewer

# Set CORS for widget serving from Shopify storefronts
cat > /tmp/cors.json << 'CORS'
[
  {
    "origin": ["*"],
    "method": ["GET"],
    "responseHeader": ["Content-Type", "Cache-Control"],
    "maxAgeSeconds": 3600
  }
]
CORS
gcloud storage buckets update gs://new-one-two-bundles-$PROJECT_ID --cors-file=/tmp/cors.json

# Frontend static hosting bucket
gcloud storage buckets create gs://$PROJECT_ID-dashboard \
  --location=$REGION \
  --uniform-bucket-level-access

gcloud storage buckets add-iam-policy-binding \
  gs://$PROJECT_ID-dashboard \
  --member=allUsers \
  --role=roles/storage.objectViewer

# Enable website serving
gcloud storage buckets update gs://$PROJECT_ID-dashboard \
  --web-main-page-suffix=index.html \
  --web-error-page=index.html
```

## Step 10: Store Secrets

```bash
# Store each secret
echo -n "YOUR_SHOPIFY_CLIENT_SECRET" | \
  gcloud secrets create shopify-client-secret --data-file=-

echo -n "YOUR_SHOPIFY_CLIENT_ID" | \
  gcloud secrets create shopify-client-id --data-file=-

echo -n "$DB_PASSWORD" | \
  gcloud secrets create db-password --data-file=-

echo -n "$REDIS_PASSWORD" | \
  gcloud secrets create redis-password --data-file=-

echo -n "YOUR_ANTHROPIC_API_KEY" | \
  gcloud secrets create anthropic-api-key --data-file=-

# Generate a dedicated JWT signing secret
openssl rand -base64 32 | \
  gcloud secrets create jwt-secret --data-file=-

# Shopify webhook HMAC secret (from Shopify Partner Dashboard)
echo -n "YOUR_WEBHOOK_HMAC_SECRET" | \
  gcloud secrets create shopify-webhook-secret --data-file=-
```

## Step 11: Create Service Accounts

```bash
# API service account
gcloud iam service-accounts create api-sa --display-name="API Service"

# Grant permissions
for role in \
  roles/secretmanager.secretAccessor \
  roles/pubsub.subscriber \
  roles/pubsub.publisher \
  roles/cloudkms.cryptoKeyEncrypterDecrypter \
  roles/storage.objectAdmin \
  roles/run.admin \
  roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:api-sa@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="$role"
done

# Worker service account (needs fewer permissions)
gcloud iam service-accounts create worker-sa --display-name="Worker Service"
for role in \
  roles/secretmanager.secretAccessor \
  roles/run.invoker; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:worker-sa@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="$role"
done

# Generator service account
gcloud iam service-accounts create generator-sa --display-name="Generator Service"
for role in \
  roles/pubsub.subscriber \
  roles/pubsub.publisher; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:generator-sa@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="$role"
done
```

## Step 12: Build and Push Docker Images

```bash
# Authenticate Docker to Artifact Registry
gcloud auth configure-docker $REGION-docker.pkg.dev

# Build and push each service
docker build -t $REGISTRY/api:v1 -f platform/apps/api/Dockerfile platform/
docker build -t $REGISTRY/webhook-gateway:v1 -f platform/apps/webhook-gateway/Dockerfile platform/
docker build -t $REGISTRY/worker:v1 -f platform/apps/worker/Dockerfile platform/
docker build -t $REGISTRY/generator:v1 -f generator/Dockerfile generator/

docker push $REGISTRY/api:v1
docker push $REGISTRY/webhook-gateway:v1
docker push $REGISTRY/worker:v1
docker push $REGISTRY/generator:v1
```

## Step 13: Deploy Cloud Run Services

Replace placeholder values below with your actual values from previous steps.

### API Service

```bash
gcloud run deploy api \
  --image=$REGISTRY/api:v1 \
  --region=$REGION \
  --service-account=api-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --memory=512Mi --cpu=1 \
  --min-instances=1 --max-instances=10 \
  --timeout=300 \
  --vpc-connector=$VPC_CONNECTOR \
  --set-env-vars="\
NODE_ENV=production,\
PORT=3002,\
SERVICE_NAME=api,\
DATABASE_URL=postgresql://platform_user:${DB_PASSWORD}@${DB_HOST}:5432/new_one_two,\
REDIS_HOST=${REDIS_HOST},\
REDIS_PORT=6379,\
REDIS_TLS=true,\
GOOGLE_CLOUD_PROJECT=${PROJECT_ID},\
DEPLOY_MODE=cloudrun,\
GCP_PROJECT=${PROJECT_ID},\
GCP_REGION=${REGION},\
DOCKER_REGISTRY=${REGISTRY},\
GCS_BUNDLES_BUCKET=new-one-two-bundles-${PROJECT_ID},\
SHOPIFY_BILLING_MODE=live,\
API_AUTH_REQUIRED=true,\
PLATFORM_URL=https://api.yourdomain.com,\
WEBHOOK_BASE_URL=https://webhooks.yourdomain.com,\
DASHBOARD_URL=https://dashboard.yourdomain.com,\
SHOPIFY_SECRET_NAME=projects/${PROJECT_ID}/secrets/shopify-webhook-secret/versions/latest" \
  --set-secrets="\
SHOPIFY_CLIENT_ID=shopify-client-id:latest,\
SHOPIFY_CLIENT_SECRET=shopify-client-secret:latest,\
REDIS_PASSWORD=redis-password:latest,\
JWT_SECRET=jwt-secret:latest,\
ALLOWED_ORIGINS=https://dashboard.yourdomain.com"
```

### Webhook Gateway

```bash
gcloud run deploy webhook-gateway \
  --image=$REGISTRY/webhook-gateway:v1 \
  --region=$REGION \
  --service-account=api-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --memory=256Mi --cpu=1 \
  --min-instances=1 --max-instances=10 \
  --timeout=60 \
  --vpc-connector=$VPC_CONNECTOR \
  --set-env-vars="\
NODE_ENV=production,\
PORT=3001,\
SERVICE_NAME=webhook-gateway,\
DATABASE_URL=postgresql://platform_user:${DB_PASSWORD}@${DB_HOST}:5432/new_one_two,\
REDIS_HOST=${REDIS_HOST},\
REDIS_PORT=6379,\
REDIS_TLS=true,\
GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --set-secrets="REDIS_PASSWORD=redis-password:latest"
```

### Worker

```bash
gcloud run deploy worker \
  --image=$REGISTRY/worker:v1 \
  --region=$REGION \
  --service-account=worker-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --no-allow-unauthenticated \
  --memory=512Mi --cpu=1 \
  --min-instances=1 --max-instances=5 \
  --timeout=300 \
  --vpc-connector=$VPC_CONNECTOR \
  --set-env-vars="\
NODE_ENV=production,\
SERVICE_NAME=worker,\
WORKER_CONCURRENCY=10,\
DATABASE_URL=postgresql://platform_user:${DB_PASSWORD}@${DB_HOST}:5432/new_one_two,\
REDIS_HOST=${REDIS_HOST},\
REDIS_PORT=6379,\
REDIS_TLS=true,\
GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --set-secrets="REDIS_PASSWORD=redis-password:latest"
```

### Generator (Python)

```bash
gcloud run deploy generator \
  --image=$REGISTRY/generator:v1 \
  --region=$REGION \
  --service-account=generator-sa@$PROJECT_ID.iam.gserviceaccount.com \
  --no-allow-unauthenticated \
  --memory=1Gi --cpu=2 \
  --min-instances=1 --max-instances=5 \
  --timeout=600 \
  --set-env-vars="\
GOOGLE_CLOUD_PROJECT=${PROJECT_ID},\
PORT=8001,\
LOG_LEVEL=info,\
LLM_VALIDATION_ENABLED=true" \
  --set-secrets="ANTHROPIC_API_KEY=anthropic-api-key:latest"
```

## Step 14: Deploy Frontend

```bash
cd platform-front

# Build with production API URL
VITE_API_URL=https://api.yourdomain.com pnpm build

# Upload to GCS
gcloud storage rsync dist/ gs://$PROJECT_ID-dashboard/ --recursive --delete-unmatched-destination-objects

# Set cache headers
gcloud storage objects update "gs://$PROJECT_ID-dashboard/assets/**" \
  --cache-control="public, max-age=31536000"
gcloud storage objects update "gs://$PROJECT_ID-dashboard/index.html" \
  --cache-control="no-cache"
```

## Step 15: Set Up Custom Domains

### Option A: Cloud Run Domain Mapping (simpler)

```bash
# Map custom domains to Cloud Run services
gcloud run domain-mappings create \
  --service=api --domain=api.yourdomain.com --region=$REGION

gcloud run domain-mappings create \
  --service=webhook-gateway --domain=webhooks.yourdomain.com --region=$REGION

# Follow the DNS instructions printed by each command (add CNAME records)
```

### Option B: Global HTTPS Load Balancer (recommended for production)

This gives you Cloud CDN, Cloud Armor (DDoS), and SSL termination. Set up via
the Console: **Network services → Load balancing → Create** and add Cloud Run
NEGs as backends.

### Frontend DNS

Point `dashboard.yourdomain.com` to the GCS bucket. The simplest way:

```bash
# Create a load balancer backend bucket
gcloud compute backend-buckets create dashboard-backend \
  --gcs-bucket-name=$PROJECT_ID-dashboard \
  --enable-cdn
```

Then add it to your HTTPS load balancer with a host rule for `dashboard.yourdomain.com`.

## Step 16: Update Shopify App Config

1. Go to **Shopify Partner Dashboard** → your app
2. Update **App URL** to `https://api.yourdomain.com/oauth/install`
3. Update **Allowed redirection URLs**:
   - `https://api.yourdomain.com/oauth/callback`
4. Update **Webhook subscriptions** callback URL:
   - `https://webhooks.yourdomain.com/webhook/{tenant_slug}/{app_slug}`

## Step 17: Verify Deployment

```bash
# Check all services are running
gcloud run services list --region=$REGION

# Test health endpoints
curl https://api.yourdomain.com/health
curl https://api.yourdomain.com/health/ready
curl https://webhooks.yourdomain.com/health/live
curl https://webhooks.yourdomain.com/health/ready

# Test OAuth flow
open "https://api.yourdomain.com/oauth/install?shop=your-dev-store.myshopify.com"
```

---

## Production Environment Variables Reference

Below is every env var, what it should be in production, and where it comes from.

### API Service

| Variable | Production Value | Source |
|----------|-----------------|--------|
| `NODE_ENV` | `production` | hardcode |
| `PORT` | `3002` | hardcode |
| `SERVICE_NAME` | `api` | hardcode |
| `DATABASE_URL` | `postgresql://user:pass@PRIVATE_IP:5432/new_one_two` | Step 5 |
| `REDIS_HOST` | Memorystore private IP | Step 6 |
| `REDIS_PORT` | `6379` | default |
| `REDIS_PASSWORD` | from Secret Manager | Step 10 |
| `REDIS_TLS` | `true` | Memorystore requires it |
| `GOOGLE_CLOUD_PROJECT` | your project ID | Step 1 |
| `DEPLOY_MODE` | `cloudrun` | hardcode |
| `GCP_PROJECT` | your project ID | Step 1 |
| `GCP_REGION` | `us-central1` | Step 1 |
| `DOCKER_REGISTRY` | `REGION-docker.pkg.dev/PROJECT/new-one-two` | Step 3 |
| `GCS_BUNDLES_BUCKET` | `new-one-two-bundles-PROJECT` | Step 9 |
| `SHOPIFY_CLIENT_ID` | from Shopify Partner Dashboard | Secret Manager |
| `SHOPIFY_CLIENT_SECRET` | from Shopify Partner Dashboard | Secret Manager |
| `SHOPIFY_SECRET_NAME` | `projects/PROJECT/secrets/shopify-webhook-secret/versions/latest` | Step 10 |
| `SHOPIFY_BILLING_MODE` | `live` (or `test` for staging) | hardcode |
| `PLATFORM_URL` | `https://api.yourdomain.com` | Step 15 |
| `WEBHOOK_BASE_URL` | `https://webhooks.yourdomain.com` | Step 15 |
| `DASHBOARD_URL` | `https://dashboard.yourdomain.com` | Step 15 |
| `API_AUTH_REQUIRED` | `true` | hardcode |
| `JWT_SECRET` | from Secret Manager | Step 10 |
| `ALLOWED_ORIGINS` | `https://dashboard.yourdomain.com` | Step 15 |

### Webhook Gateway

| Variable | Production Value |
|----------|-----------------|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `SERVICE_NAME` | `webhook-gateway` |
| `DATABASE_URL` | same as API |
| `REDIS_HOST` | same as API |
| `REDIS_PORT` | `6379` |
| `REDIS_PASSWORD` | same as API |
| `REDIS_TLS` | `true` |
| `GOOGLE_CLOUD_PROJECT` | your project ID |

### Worker

| Variable | Production Value |
|----------|-----------------|
| `NODE_ENV` | `production` |
| `SERVICE_NAME` | `worker` |
| `WORKER_CONCURRENCY` | `10` |
| `DATABASE_URL` | same as API |
| `REDIS_HOST` | same as API |
| `REDIS_PORT` | `6379` |
| `REDIS_PASSWORD` | same as API |
| `REDIS_TLS` | `true` |
| `GOOGLE_CLOUD_PROJECT` | your project ID |

### Generator (Python)

| Variable | Production Value |
|----------|-----------------|
| `GOOGLE_CLOUD_PROJECT` | your project ID |
| `PORT` | `8001` |
| `LOG_LEVEL` | `info` |
| `ANTHROPIC_API_KEY` | from Secret Manager |
| `LLM_VALIDATION_ENABLED` | `true` |

**Do NOT set** `PUBSUB_EMULATOR_HOST` in production — the SDK auto-discovers
real Pub/Sub via Application Default Credentials.

**Do NOT set** `KMS_DEV_KEY`, `SM_DEV_SECRETS`, or `CLOUD_RUN_SKIP_AUTH` in
production — these are dev-only escape hatches.

---

## CI/CD (GitHub Actions)

The pipeline at `.github/workflows/build-deploy.yml` automates everything above.

### Required GitHub Secrets

Set these in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|-------|
| `GCP_PROJECT_ID` | your GCP project ID |
| `GCP_REGION` | `us-central1` |
| `GCP_SA_KEY` | JSON key for a CI service account (see below) |
| `DOCKER_REGISTRY` | `us-central1-docker.pkg.dev/PROJECT/new-one-two` |
| `VPC_CONNECTOR` | full connector path from Step 4 |
| `DB_PASSWORD` | database password from Step 5 |
| `DB_USER` | `platform_user` |
| `DB_NAME` | `new_one_two` |
| `API_URL` | `https://api.yourdomain.com` |
| `FRONTEND_BUCKET` | `PROJECT-dashboard` |

### Required GitHub Variables

| Variable | Value |
|----------|-------|
| `CLOUD_SQL_CONNECTION` | `PROJECT:REGION:new-one-two-db` |

### CI Service Account

```bash
gcloud iam service-accounts create github-ci --display-name="GitHub CI"

for role in \
  roles/artifactregistry.writer \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/cloudsql.client \
  roles/storage.admin; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-ci@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="$role"
done

# Create key (save as GCP_SA_KEY secret in GitHub)
gcloud iam service-accounts keys create /tmp/ci-key.json \
  --iam-account=github-ci@$PROJECT_ID.iam.gserviceaccount.com

cat /tmp/ci-key.json   # copy this entire JSON as the GCP_SA_KEY secret
rm /tmp/ci-key.json
```

---

## Post-Deploy Checklist

- [ ] All health endpoints return 200
- [ ] OAuth install flow works end-to-end with a Shopify test store
- [ ] Webhook delivery works (check via Shopify Partner Dashboard → Webhooks)
- [ ] Generation → progress SSE → bundle → deploy flow completes
- [ ] Widget JS loads on a test storefront (check browser network tab)
- [ ] Billing subscribe/cancel works (use `SHOPIFY_BILLING_MODE=test` first)
- [ ] Dashboard loads and shows merchant data
- [ ] Cloud SQL automated backups are running (check Console)
- [ ] Set up Cloud Monitoring alerts for 5xx error rate and latency
