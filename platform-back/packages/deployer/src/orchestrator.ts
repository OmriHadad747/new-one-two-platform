import { rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { logger } from "@platform-back/logger";
import { buildAndPushImage } from "./build-image.js";
import { assembleBuildContext, type GeneratedFile } from "./build-context.js";
import { deployToCloudRun } from "./cloud-run-ops.js";
import { scheduleAppCron, unscheduleAppCron } from "./cron-scheduler.js";
import { registerWebhooks } from "./webhook-registrar.js";
import { upsertDeployedFunction } from "./db-writer.js";
import { deactivateRemovedWebhookSubscriptions } from "@platform-back/db";
import { runMigrations } from "./migration-runner.js";
import {
  grantPlatformBackInvokerOnHandler,
  provisionHandlerSa,
} from "./sa-provisioner.js";

// End-to-end deploy orchestrator. Sequences every sub-phase A-C piece
// in the right order, emits per-step progress events for the SSE route,
// returns terminal state.
//
// Job state lives in-process (Map keyed by jobId). Lost on restart —
// fine for phase 1 single-instance deploys; not fine once platform-back
// scales horizontally. Captured as follow-up: persist to a deploy_jobs
// table once we hit that.

export const DEPLOY_STEPS = [
  "provision_sa",
  "assemble_build_context",
  "build_image",
  "run_migrations",
  "deploy_cloud_run",
  "grant_invoker",
  "db_writes",
  "register_webhooks",
  "schedule_cron",
] as const;

export type DeployStep = (typeof DEPLOY_STEPS)[number];
export type DeployStepStatus = "pending" | "running" | "done" | "failed";
export type DeployJobStatus = "running" | "succeeded" | "failed";

export interface DeployStepState {
  step: DeployStep;
  status: DeployStepStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface DeployJobEvent {
  jobId: string;
  appId: string;
  tenantId: string;
  status: DeployJobStatus;
  steps: DeployStepState[];
  /** Populated on terminal success. */
  functionUrl?: string;
  /** Populated on terminal failure. */
  error?: string;
  updatedAt: string;
}

export interface StartDeployInput {
  appId: string;
  appName: string;
  appVersionId: string;
  tenantId: string;
  shopDomain: string;
  /** tenant_<uuid> Postgres schema. */
  tenantSchema: string;
  /** Bundle of generator-emitted files slotted on top of handler-template. */
  generatedFiles: GeneratedFile[];
  /** Image tag — typically the app version semver or git sha. */
  appVersion: string;
  /** Env vars to inject into the deployed Cloud Run service. */
  handlerEnv?: Record<string, string>;
  /** SA email if the app already has one (re-deploy); null on first deploy. */
  existingHandlerSaEmail?: string | null;
  /**
   * Cron expression from handlerModule.cronSchedule, or null for apps
   * that don't have a scheduled tick. When set, step 9 registers a
   * pg_cron job; when null and a schedule already exists for this app
   * (re-deploy that dropped cron), step 9 unschedules it.
   */
  cronSchedule?: string | null;
  /** Human-readable slugs used to build the webhook-gateway callback URL. */
  appSlug: string;
  tenantSlug: string;
  /**
   * Topics from handlerModule.webhookTopics. Step 8 registers/reconciles
   * Shopify subscriptions and syncs webhook_subscriptions in DB. Pass an
   * empty array (or omit) for apps with no webhook handler.
   */
  webhookTopics?: string[];
}

interface JobContext {
  jobId: string;
  state: DeployJobEvent;
  emitter: EventEmitter;
}

const jobs = new Map<string, JobContext>();

export function getDeployJob(jobId: string): DeployJobEvent | null {
  return jobs.get(jobId)?.state ?? null;
}

/**
 * Subscribe to live events for a job. The first emission is the current
 * state so late subscribers don't miss earlier transitions. Returns an
 * unsubscribe function.
 */
export function subscribeDeployJob(
  jobId: string,
  onEvent: (event: DeployJobEvent) => void,
): (() => void) | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  // Snapshot first so SSE clients see something on initial connect.
  onEvent(structuredClone(job.state));
  job.emitter.on("event", onEvent);
  return () => job.emitter.off("event", onEvent);
}

/**
 * Kicks off a deploy. Returns the jobId immediately; the actual work
 * runs asynchronously and emits events on each step transition.
 *
 * The promise returned by this function resolves once the job is
 * REGISTERED (not finished). Callers should subscribe via
 * subscribeDeployJob to learn about progress / completion.
 */
export async function startDeploy(input: StartDeployInput): Promise<string> {
  const jobId = crypto.randomUUID();
  const initialSteps: DeployStepState[] = DEPLOY_STEPS.map((step) => ({
    step,
    status: "pending",
  }));
  const ctx: JobContext = {
    jobId,
    emitter: new EventEmitter(),
    state: {
      jobId,
      appId: input.appId,
      tenantId: input.tenantId,
      status: "running",
      steps: initialSteps,
      updatedAt: new Date().toISOString(),
    },
  };
  jobs.set(jobId, ctx);

  // Fire-and-forget — orchestration runs in the background and pushes
  // events. Wrap in a `void` IIFE so the unhandled-rejection trap fires
  // on bugs (vs. swallowing inside the EventEmitter).
  void (async () => {
    try {
      await runDeploy(ctx, input);
    } catch (err) {
      logger.error({ err, jobId, appId: input.appId }, "Deploy job crashed");
    }
  })();

  return jobId;
}

// ─── Internal orchestration ──────────────────────────────────────────────────

function pushEvent(ctx: JobContext): void {
  ctx.state.updatedAt = new Date().toISOString();
  ctx.emitter.emit("event", structuredClone(ctx.state));
}

async function runStep<T>(
  ctx: JobContext,
  step: DeployStep,
  fn: () => Promise<T>,
): Promise<T> {
  const stepState = ctx.state.steps.find((s) => s.step === step)!;
  stepState.status = "running";
  stepState.startedAt = new Date().toISOString();
  pushEvent(ctx);
  try {
    const result = await fn();
    stepState.status = "done";
    stepState.finishedAt = new Date().toISOString();
    pushEvent(ctx);
    return result;
  } catch (err) {
    stepState.status = "failed";
    stepState.finishedAt = new Date().toISOString();
    stepState.error = err instanceof Error ? err.message : String(err);
    pushEvent(ctx);
    throw err;
  }
}

async function runDeploy(
  ctx: JobContext,
  input: StartDeployInput,
): Promise<void> {
  let buildDir: string | undefined;

  try {
    // 1. Provision (or look up) the per-handler SA.
    const sa = await runStep(ctx, "provision_sa", () =>
      provisionHandlerSa({
        shopDomain: input.shopDomain,
        appId: input.appId,
        appName: input.appName,
        existingEmail: input.existingHandlerSaEmail ?? null,
      }),
    );

    // 2. Assemble the docker build context.
    buildDir = (
      await runStep(ctx, "assemble_build_context", () =>
        assembleBuildContext({
          generatedFiles: input.generatedFiles,
          tenantId: input.tenantId,
          appId: input.appId,
          appVersion: input.appVersion,
        }),
      )
    ).buildDir;

    // 3. Build + push image.
    const image = await runStep(ctx, "build_image", () =>
      buildAndPushImage({
        appId: input.appId,
        version: input.appVersion,
        buildContextDir: buildDir!,
      }),
    );

    // 4. Run migrations against the tenant schema. The validator gate
    //    runs only on generator-emitted .sql files (i.e. those in
    //    input.generatedFiles whose path is under migrations/).
    const generatorAuthoredMigrations = input.generatedFiles
      .filter((f) => /^migrations\/[^/]+\.sql$/.test(f.path))
      .map((f) => f.path.replace(/^migrations\//, ""));

    await runStep(ctx, "run_migrations", () =>
      runMigrations({
        buildContextDir: buildDir!,
        tenantSchema: input.tenantSchema,
        databaseUrl: requireEnv("DATABASE_URL"),
        generatorAuthoredNames: generatorAuthoredMigrations,
      }),
    );

    // 5. Deploy to Cloud Run with the per-handler SA bound.
    const cloudRun = await runStep(ctx, "deploy_cloud_run", () =>
      deployToCloudRun({
        appId: input.appId,
        imageName: image.imageName,
        serviceAccountEmail: sa.email,
        envVars: buildHandlerEnv(input),
      }),
    );

    // 6. Grant platform-back's SA invoker on the new service.
    await runStep(ctx, "grant_invoker", () =>
      grantPlatformBackInvokerOnHandler(input.appId),
    );

    // 7. DB writes — record the active deployment.
    const dbResult = await runStep(ctx, "db_writes", () =>
      upsertDeployedFunction({
        appVersionId: input.appVersionId,
        appId: input.appId,
        tenantId: input.tenantId,
        functionUrl: cloudRun.functionUrl,
        runtime: "nodejs20",
        memoryMb: 256,
        timeoutSec: 30,
      }),
    );

    // 8. Reconcile Shopify webhook subscriptions for this deploy. When
    //    webhookTopics is non-empty, registers any missing topics with
    //    Shopify and syncs the webhook_subscriptions table pointing at
    //    the new deployed_function row. When empty, deactivates stale
    //    subscriptions so the gateway stops routing to a dead function.
    await runStep(ctx, "register_webhooks", async () => {
      const topics = input.webhookTopics ?? [];
      if (topics.length > 0) {
        await registerWebhooks({
          appId: input.appId,
          appSlug: input.appSlug,
          tenantId: input.tenantId,
          tenantSlug: input.tenantSlug,
          shopDomain: input.shopDomain,
          deployedFunctionId: dbResult.id,
          webhookTopics: topics,
        });
      } else {
        await deactivateRemovedWebhookSubscriptions(input.appId, []);
      }
    });

    // 9. Register (or remove) the pg_cron schedule for this app.
    //    When cronSchedule is set: create/replace the per-app tick.
    //    When null: unschedule any prior registration so a re-deploy
    //    that dropped cron stops ticking the (now-dead) queue.
    //    Either way, idempotent and safe.
    await runStep(ctx, "schedule_cron", async () => {
      if (input.cronSchedule) {
        await scheduleAppCron({
          appId: input.appId,
          tenantSchema: input.tenantSchema,
          cronExpression: input.cronSchedule,
          databaseUrl: requireEnv("DATABASE_URL"),
        });
      } else {
        await unscheduleAppCron({
          appId: input.appId,
          databaseUrl: requireEnv("DATABASE_URL"),
        });
      }
    });

    ctx.state.status = "succeeded";
    ctx.state.functionUrl = cloudRun.functionUrl;
    pushEvent(ctx);
    logger.info(
      {
        jobId: ctx.jobId,
        appId: input.appId,
        functionUrl: cloudRun.functionUrl,
      },
      "Deploy succeeded",
    );
  } catch (err) {
    ctx.state.status = "failed";
    ctx.state.error = err instanceof Error ? err.message : String(err);
    pushEvent(ctx);
    logger.error(
      { err, jobId: ctx.jobId, appId: input.appId },
      "Deploy failed",
    );
  } finally {
    if (buildDir) {
      await rm(buildDir, { recursive: true, force: true }).catch((err) => {
        logger.warn({ err, buildDir }, "Failed to clean up build context");
      });
    }
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function buildHandlerEnv(input: StartDeployInput): Record<string, string> {
  // Baseline env every handler needs. Caller can override / extend via
  // input.handlerEnv. TENANT_ID / APP_ID / SHOP_DOMAIN come from here so
  // the handler doesn't have to look them up at startup.
  //
  // ENABLE_CRON_RUNNER is derived from the bundle itself: if the generator
  // emitted src/routes/cron.ts, cron is part of this app — start the
  // runner on boot. Otherwise the template ships a stub cron.ts and the
  // runner stays off. CRON_NOTIFY_CHANNEL is the Postgres LISTEN channel
  // the runner subscribes to — keyed on the app id so pg_cron's per-tick
  // NOTIFY only wakes the right handler.
  const hasCronRoute = input.generatedFiles.some(
    (f) => f.path === "src/routes/cron.ts",
  );

  return {
    NODE_ENV: "production",
    PORT: "8080",
    TENANT_ID: input.tenantId,
    APP_ID: input.appId,
    SHOP_DOMAIN: input.shopDomain,
    TENANT_SCHEMA: input.tenantSchema,
    DATABASE_URL: requireEnv("DATABASE_URL"),
    PLATFORM_URL: requireEnv("PLATFORM_URL"),
    EXPECTED_AUDIENCE: requireEnv("PLATFORM_URL"),
    PLATFORM_SA_EMAIL: process.env["PLATFORM_SA_EMAIL"] ?? "",
    ENABLE_CRON_RUNNER: hasCronRoute ? "true" : "false",
    CRON_NOTIFY_CHANNEL: `cron_tick_${input.appId.replace(/-/g, "_")}`,
    ...(input.handlerEnv ?? {}),
  };
}
