# GCP Deployment — New One Two

Production project: **`newonetwo-493019`** · Region: **`us-central1`**

---

## Architecture

```
Internet
  ├── dashboard.newonetwo.com  → HTTPS Load Balancer → GCS bucket (frontend SPA)
  ├── api.newonetwo.com        → Cloud Run: api          (port 3002)
  └── webhooks.newonetwo.com   → Cloud Run: webhook-gateway (port 3001)

Cloud Run services (all in us-central1, VPC connector: platform-connector)
  api              — REST + OAuth + SSE
  webhook-gateway  — Shopify webhook intake → Redis queue
  worker           — BullMQ consumer → invokes per-tenant harness
  generator        — Python/FastAPI, AI code generation

Data layer
  Cloud SQL Postgres 16  — new-one-two-db (private IP + public IP for CI/local dev via Cloud SQL Proxy)
  Memorystore Redis 7    — private VPC IP, port 6378, TLS + auth
  Secret Manager         — secrets referenced by name
  Cloud KMS              — keyring: platform-keys, key: tenant-secrets
  GCS                    — newonetwo-493019-dashboard (frontend)
                           new-one-two-bundles-newonetwo-493019 (widget JS)
  Pub/Sub topics         — generation.requested / progress / completed
```

---

## Initial Setup (one-time, already done for newonetwo-493019)

```bash
export PROJECT_ID=newonetwo-493019
export REGION=us-central1
export REGISTRY=$REGION-docker.pkg.dev/$PROJECT_ID/new-one-two

gcloud config set project $PROJECT_ID

# Enable APIs
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com \
  redis.googleapis.com pubsub.googleapis.com cloudkms.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com vpcaccess.googleapis.com \
  compute.googleapis.com servicenetworking.googleapis.com

# Artifact Registry
gcloud artifacts repositories create new-one-two \
  --repository-format=docker --location=$REGION

# VPC connector (Cloud Run → private Redis/SQL)
gcloud compute networks vpc-access connectors create platform-connector \
  --region=$REGION --range=10.8.0.0/28
```

---

## Cloud SQL

Instance: `new-one-two-db` · Postgres 16 · Private IP only

```bash
gcloud sql instances create new-one-two-db \
  --database-version=POSTGRES_16 --edition=ENTERPRISE \
  --tier=db-custom-1-3840 --region=$REGION \
  --storage-size=20GB --storage-auto-increase \
  --availability-type=zonal \
  --enable-point-in-time-recovery --backup-start-time=03:00 \
  --network=default --no-assign-ip

gcloud sql databases create new_one_two --instance=new-one-two-db
gcloud sql users create platform_user --instance=new-one-two-db --password=<password>
```

> **CI note:** GitHub Actions runners have no VPC access. The migration job uses
> Cloud SQL Proxy with `--assign-ip` (public IP enabled on the instance) and
> connects via IAM auth from the `github-ci` service account.

### Running migrations manually

```bash
cloud-sql-proxy newonetwo-493019:us-central1:new-one-two-db --port 5432 &
for f in platform/packages/db/migrations/*.sql; do
  PGPASSWORD=$DB_PASSWORD psql -h 127.0.0.1 -U platform_user -d new_one_two -f "$f"
done
```

---

## Memorystore (Redis)

Instance: `new-one-two-redis` · Redis 7 · TLS + AUTH

```bash
gcloud redis instances create new-one-two-redis \
  --size=1 --region=$REGION --redis-version=redis_7_0 \
  --transit-encryption-mode=SERVER_AUTHENTICATION --auth-enabled
```

**Actual connection values:**

| Variable | Value |
|----------|-------|
| `REDIS_HOST` | private IP — run `gcloud redis instances describe new-one-two-redis --region=us-central1 --format="value(host)"` |
| `REDIS_PORT` | `6378` |
| `REDIS_TLS` | `true` |
| `REDIS_PASSWORD` | in Secret Manager (`redis-password`) |

---

## Pub/Sub

```bash
for topic in generation.requested generation.progress generation.completed; do
  gcloud pubsub topics create $topic
done
gcloud pubsub subscriptions create generator-sub   --topic=generation.requested --ack-deadline=600
gcloud pubsub subscriptions create api-progress-sub --topic=generation.progress  --ack-deadline=30
gcloud pubsub subscriptions create api-completed-sub --topic=generation.completed --ack-deadline=30
```

---

## GCS Buckets

```bash
# Widget JS bundles — public read, CORS open
gcloud storage buckets create gs://new-one-two-bundles-$PROJECT_ID \
  --location=$REGION --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://new-one-two-bundles-$PROJECT_ID \
  --member=allUsers --role=roles/storage.objectViewer

# Frontend SPA — public read, website mode
gcloud storage buckets create gs://$PROJECT_ID-dashboard \
  --location=$REGION --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://$PROJECT_ID-dashboard \
  --member=allUsers --role=roles/storage.objectViewer
gcloud storage buckets update gs://$PROJECT_ID-dashboard \
  --web-main-page-suffix=index.html --web-error-page=index.html
```

---

## Secret Manager

```bash
for name_value in \
  "shopify-client-secret:<value>" \
  "shopify-client-id:<value>" \
  "db-password:<value>" \
  "redis-password:<value>" \
  "anthropic-api-key:<value>" \
  "jwt-secret:$(openssl rand -base64 32)" \
  "shopify-webhook-secret:<value>"; do
  name="${name_value%%:*}"
  value="${name_value#*:}"
  echo -n "$value" | gcloud secrets create "$name" --data-file=-
done
```

---

## Service Accounts

```bash
# API + webhook-gateway (broad permissions)
gcloud iam service-accounts create api-sa --display-name="API Service"
for role in roles/secretmanager.secretAccessor roles/pubsub.subscriber \
  roles/pubsub.publisher roles/cloudkms.cryptoKeyEncrypterDecrypter \
  roles/storage.objectAdmin roles/run.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:api-sa@$PROJECT_ID.iam.gserviceaccount.com" --role=$role
done

# Worker (invoke Cloud Run only)
gcloud iam service-accounts create worker-sa --display-name="Worker Service"
for role in roles/secretmanager.secretAccessor roles/run.invoker; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:worker-sa@$PROJECT_ID.iam.gserviceaccount.com" --role=$role
done

# Generator (Pub/Sub only)
gcloud iam service-accounts create generator-sa --display-name="Generator Service"
for role in roles/pubsub.subscriber roles/pubsub.publisher; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:generator-sa@$PROJECT_ID.iam.gserviceaccount.com" --role=$role
done
```

---

## CI/CD (GitHub Actions)

Pipeline: `.github/workflows/build-deploy.yml`

Triggers: push to `main` (→ production), push to `staging`, or manual dispatch.

Jobs: **setup → build (matrix) → migrate → deploy (matrix) → frontend**

### CI Service Account

```bash
gcloud iam service-accounts create github-ci --display-name="GitHub CI"
for role in roles/artifactregistry.writer roles/run.admin \
  roles/iam.serviceAccountUser roles/cloudsql.client roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-ci@$PROJECT_ID.iam.gserviceaccount.com" --role=$role
done
gcloud iam service-accounts keys create /tmp/ci-key.json \
  --iam-account=github-ci@$PROJECT_ID.iam.gserviceaccount.com
# Paste the contents of ci-key.json as the GCP_SA_KEY GitHub secret
```

### GitHub Secrets (sensitive)

| Secret | Description |
|--------|-------------|
| `GCP_SA_KEY` | CI service account key JSON |
| `DATABASE_URL` | Full Postgres connection string |
| `REDIS_PASSWORD` | Memorystore AUTH string |
| `JWT_SECRET` | JWT signing key |
| `SHOPIFY_CLIENT_ID` | Shopify OAuth app ID |
| `SHOPIFY_CLIENT_SECRET` | Shopify OAuth app secret |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DB_PASSWORD` | Postgres password (migrations only) |
| `DB_USER` | Postgres user (migrations only) |
| `DB_NAME` | Postgres DB name (migrations only) |

### GitHub Variables (non-sensitive config)

| Variable | Current value |
|----------|---------------|
| `GCP_PROJECT_ID` | `newonetwo-493019` |
| `GCP_REGION` | `us-central1` |
| `DOCKER_REGISTRY` | `us-central1-docker.pkg.dev/newonetwo-493019/new-one-two` |
| `CLOUD_SQL_CONNECTION` | `newonetwo-493019:us-central1:new-one-two-db` |
| `REDIS_HOST` | private Memorystore IP (see above) |
| `REDIS_PORT` | `6378` |
| `ALLOWED_ORIGINS` | `https://dashboard.newonetwo.com` |
| `VPC_CONNECTOR` | `platform-connector` |
| `FRONTEND_BUCKET` | `newonetwo-493019-dashboard` |
| `API_URL` | `https://api.newonetwo.com` |

---

## Frontend: HTTPS Load Balancer + Custom Domain

The SPA is served from GCS via a global HTTPS load balancer with a managed SSL cert.

**Existing resources (already created):**

| Resource | Name / Value |
|----------|-------------|
| Static IP | `dashboard-ip` → `34.120.8.28` |
| Backend bucket | `dashboard-backend` (CDN enabled, points to `newonetwo-493019-dashboard`) |
| URL map | `dashboard-url-map` |
| SSL certificate | `dashboard-cert` for `dashboard.newonetwo.com` |
| HTTPS proxy + rule | port 443 |
| HTTP redirect | port 80 → HTTPS |

**To recreate from scratch:**

```bash
# Reserve static IP
gcloud compute addresses create dashboard-ip --global

# Backend bucket
gcloud compute backend-buckets create dashboard-backend \
  --gcs-bucket-name=newonetwo-493019-dashboard --enable-cdn

# URL map
gcloud compute url-maps create dashboard-url-map \
  --default-backend-bucket=dashboard-backend

# Managed SSL certificate
gcloud compute ssl-certificates create dashboard-cert \
  --domains=dashboard.newonetwo.com

# HTTPS proxy + forwarding rule
gcloud compute target-https-proxies create dashboard-https-proxy \
  --url-map=dashboard-url-map --ssl-certificates=dashboard-cert
gcloud compute forwarding-rules create dashboard-https-rule \
  --global --target-https-proxy=dashboard-https-proxy \
  --address=dashboard-ip --ports=443

# HTTP → HTTPS redirect
gcloud compute url-maps import dashboard-http-redirect --global << 'EOF'
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
EOF
gcloud compute target-http-proxies create dashboard-http-proxy \
  --url-map=dashboard-http-redirect
gcloud compute forwarding-rules create dashboard-http-rule \
  --global --target-http-proxy=dashboard-http-proxy \
  --address=dashboard-ip --ports=80
```

### DNS setup (Squarespace)

Go to **Domains → newonetwo.com → DNS Settings → Custom Records**, add:

| Type | Host | Data | TTL |
|------|------|------|-----|
| `A` | `dashboard` | `34.120.8.28` | 3600 |

The managed cert (`dashboard-cert`) provisions automatically once DNS propagates (~15 min after the A record is live). Check status:

```bash
gcloud compute ssl-certificates describe dashboard-cert \
  --format="value(managed.status,managed.domainStatus)"
```

Status will change from `PROVISIONING` → `ACTIVE` when done.

---

## Custom Domains for API & Webhooks (TODO)

The easiest method is Cloud Run domain mapping:

```bash
gcloud run domain-mappings create --service=api \
  --domain=api.newonetwo.com --region=$REGION

gcloud run domain-mappings create --service=webhook-gateway \
  --domain=webhooks.newonetwo.com --region=$REGION
```

Each command prints the DNS records to add (CNAME or A).

---

## Verify Deployment

```bash
# All services should show ACTIVE
gcloud run services list --region=us-central1

# Health checks
curl https://api.newonetwo.com/health
curl https://webhooks.newonetwo.com/health/live

# Dashboard
open https://dashboard.newonetwo.com
```

---

## Cost Summary

Estimated monthly cost for production (us-central1):

| Resource | Config | Est. $/mo |
|----------|--------|-----------|
| Cloud SQL | `db-custom-1-3840`, 20 GB, zonal | ~$52 |
| Memorystore Redis | 1 GB, Redis 7, TLS | ~$49 |
| Cloud Run — api | 1 min instance, 512 MB, 1 vCPU | ~$15 |
| Cloud Run — webhook-gateway | 1 min instance, 256 MB, 1 vCPU | ~$10 |
| Cloud Run — worker | 1 min instance, 512 MB, 1 vCPU | ~$15 |
| Cloud Run — generator | 1 min instance, 1 GB, 2 vCPU | ~$35 |
| HTTPS Load Balancer | 1 rule + managed cert | ~$18 |
| Artifact Registry | ~5 GB images | ~$0.50 |
| GCS (frontend + bundles) | <1 GB + egress | ~$1 |
| Pub/Sub | low volume | ~$0 |
| Secret Manager | 10 secrets | ~$0.06 |
| Cloud KMS | 1 key, low ops | ~$0.03 |
| **Total estimate** | | **~$196/mo** |

> Costs scale primarily with Cloud Run requests and Cloud SQL CPU. At zero traffic,
> Cloud Run with `--min-instances=1` idles at the values above. With
> `--min-instances=0` you save ~$75/mo but get cold starts on first requests.
>
> To upgrade Cloud SQL for higher traffic: `gcloud sql instances patch new-one-two-db --tier=db-custom-2-7680` (~$103/mo)

---

## Post-Deploy Checklist

- [ ] All Cloud Run services show `ACTIVE` (`gcloud run services list`)
- [ ] `dashboard-cert` SSL status is `ACTIVE`
- [ ] `https://dashboard.newonetwo.com` loads
- [ ] OAuth install flow works end-to-end with a Shopify test store
- [ ] Webhook delivery works (Shopify Partner Dashboard → Webhooks)
- [ ] Generation → progress SSE → bundle → deploy flow completes
- [ ] Widget JS loads on a test storefront
- [ ] Cloud SQL automated backups running (Console → SQL → Backups)
- [ ] Set up Cloud Monitoring alerts for 5xx error rate and p99 latency
