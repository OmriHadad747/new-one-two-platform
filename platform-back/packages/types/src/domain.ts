// Domain types — mirrors the PostgreSQL enum/check-constraint vocabulary.
// Single source of truth for string unions shared across packages (db,
// deployer, api, webhook-gateway). Prefer importing from here over
// inlining the same literals in multiple places.

export type AppStatus = "draft" | "ready" | "active" | "inactive" | "deleted";

// Canonical archetype vocabulary shared between the generator (appArchetype
// in its output bundle) and the platform (app_archetype DB column).
export type AppArchetype =
  | "storefront_backend"
  | "storefront_backend_admin"
  | "backend"
  | "backend_admin";

export type FileStatus = "active" | "pending" | "failed";

export type GenerationStatus = "success" | "failed";

export type RevisionClassification =
  | "bug_report"
  | "feature_modification"
  | "new_capability";

// Subset of execution_status enum used on webhook invocation log updates.
export type WebhookInvocationLogStatus = "running" | "success" | "failed";

// Node.js runtime versions available for handler Cloud Run services.
export type HandlerRuntime = "nodejs20" | "nodejs18";
