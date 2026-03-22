#!/bin/bash
# ─── GCP Dev Init Script ───────────────────────────────────────────────────────
# Generates a local dev KMS key and prints the env var to set.
# Run once after cloning: bash scripts/gcp-init.sh >> .env

set -euo pipefail

echo ">>> Generating KMS_DEV_KEY (32 random bytes, base64-encoded)..."
DEV_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

echo ""
echo "Add this to your .env file:"
echo ""
echo "KMS_DEV_KEY=${DEV_KEY}"
echo ""
echo ">>> Done. The fake-gcs-server container creates the GCS bucket automatically on startup."
echo ">>> For production KMS, create a key ring and key in Cloud Console:"
echo "    gcloud kms keyrings create new-one-two --location global"
echo "    gcloud kms keys create platform-key --keyring new-one-two --location global --purpose encryption"
