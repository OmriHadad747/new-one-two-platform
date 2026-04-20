// Runs in each worker before any test file is loaded.
// Module-level constants (DEPLOY_MODE, GCP_PROJECT) are evaluated at import
// time, so these must be set here — not in beforeEach.
process.env["DEPLOY_MODE"] = "local";
process.env["GCP_PROJECT"] = "test-project";
process.env["GCP_REGION"] = "us-central1";
process.env["DOCKER_REGISTRY"] = "gcr.io/test-project";
