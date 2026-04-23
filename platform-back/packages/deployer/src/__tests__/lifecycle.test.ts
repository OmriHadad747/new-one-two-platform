import { describe, it, expect, vi, beforeEach } from "vitest";

// All external I/O mocked — lifecycle.ts is pure orchestration logic.
vi.mock("@platform-back/db", () => ({
  getAppById: vi.fn(),
  getTenantById: vi.fn(),
  getActiveWebhookSubscriptionsForApp: vi.fn(),
  getLatestDeployedVersionForApp: vi.fn(),
  getAppVersionSemvers: vi.fn(),
  getGcsObjectsForApp: vi.fn(),
  deactivateAppInfrastructure: vi.fn(),
  hardDeleteApp: vi.fn(),
}));
vi.mock("@platform-back/files", () => ({
  deleteObjectsBatch: vi.fn(),
}));
vi.mock("@platform-back/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../cloud-run-ops.js", () => ({
  deployToCloudRun: vi.fn(),
  deleteCloudRunService: vi.fn(),
}));
vi.mock("../iam-ops.js", () => ({
  deleteServiceAccount: vi.fn(),
}));
vi.mock("../build-image.js", () => ({
  deleteDockerImage: vi.fn(),
  dockerImageName: vi.fn((appId: string, semver: string) => `gcr.io/test/${appId}:${semver}`),
}));
vi.mock("../webhook-registrar.js", () => ({
  registerWebhooks: vi.fn(),
  unregisterShopifyWebhooks: vi.fn(),
}));
vi.mock("../cron-scheduler.js", () => ({
  scheduleAppCron: vi.fn(),
  unscheduleAppCron: vi.fn(),
}));
vi.mock("../migration-runner.js", () => ({
  appSchemaName: vi.fn(() => "tenant_aabbccdd_app_11223344"),
  dropAppSchema: vi.fn().mockResolvedValue({ dropped: true }),
}));
vi.mock("../service-namer.js", () => ({
  dockerImageName: vi.fn((appId: string, semver: string) => `gcr.io/test/${appId}:${semver}`),
}));

import {
  getAppById, getTenantById, getActiveWebhookSubscriptionsForApp,
  getLatestDeployedVersionForApp, getAppVersionSemvers, getGcsObjectsForApp,
  deactivateAppInfrastructure, hardDeleteApp,
} from "@platform-back/db";
import { deleteObjectsBatch } from "@platform-back/files";
import { deployToCloudRun, deleteCloudRunService } from "../cloud-run-ops.js";
import { deleteServiceAccount } from "../iam-ops.js";
import { deleteDockerImage } from "../build-image.js";
import { registerWebhooks, unregisterShopifyWebhooks } from "../webhook-registrar.js";
import { scheduleAppCron, unscheduleAppCron } from "../cron-scheduler.js";
import { dropAppSchema } from "../migration-runner.js";
import { teardownApp, reactivateApp, permanentDeleteApp } from "../lifecycle.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const APP_ID    = "22222222-2222-2222-2222-222222222222";
const SA_EMAIL  = "h-acme-1@test-project.iam.gserviceaccount.com";

const MOCK_APP = {
  id: APP_ID,
  tenantId: TENANT_ID,
  slug: "my-app",
  shopDomain: "acme.myshopify.com",
  status: "active",
  handlerSaEmail: SA_EMAIL,
};

const MOCK_TENANT = {
  id: TENANT_ID,
  slug: "acme",
  shopDomain: "acme.myshopify.com",
  shopifyAccessTokenSecretName: "projects/p/secrets/acme-token/versions/latest",
};

const MOCK_WEBHOOKS = [
  { id: "ws-1", topic: "orders/create", shopifyWebhookId: "shp-1" },
];

const MOCK_LATEST = {
  deployedFunctionId: "df-1",
  appVersionId: "av-1",
  semver: "1.0.0",
  imageName: null,
  webhookTopics: ["orders/create"],
  cronSchedule: "*/5 * * * *",
};

beforeEach(() => {
  vi.mocked(getAppById).mockResolvedValue(MOCK_APP as never);
  vi.mocked(getTenantById).mockResolvedValue(MOCK_TENANT as never);
  vi.mocked(getActiveWebhookSubscriptionsForApp).mockResolvedValue(MOCK_WEBHOOKS as never);
  vi.mocked(getLatestDeployedVersionForApp).mockResolvedValue(MOCK_LATEST as never);
  vi.mocked(getAppVersionSemvers).mockResolvedValue(["1.0.0", "0.9.0"]);
  vi.mocked(getGcsObjectsForApp).mockResolvedValue(["tenants/t/apps/a/file1"]);
  vi.mocked(deactivateAppInfrastructure).mockResolvedValue(undefined);
  vi.mocked(hardDeleteApp).mockResolvedValue(undefined);
  vi.mocked(deleteObjectsBatch).mockResolvedValue({ deleted: 1, failed: 0 } as never);
  vi.mocked(deleteCloudRunService).mockResolvedValue(undefined);
  vi.mocked(deleteServiceAccount).mockResolvedValue(undefined);
  vi.mocked(deleteDockerImage).mockResolvedValue(undefined);
  vi.mocked(unregisterShopifyWebhooks).mockResolvedValue(undefined);
  vi.mocked(unscheduleAppCron).mockResolvedValue({ removed: true });
  vi.mocked(deployToCloudRun).mockResolvedValue({ functionUrl: "https://handler.run.app", serviceName: "h-acme" } as never);
  vi.mocked(registerWebhooks).mockResolvedValue(undefined);
  vi.mocked(scheduleAppCron).mockResolvedValue(undefined);
  vi.mocked(dropAppSchema).mockResolvedValue({ dropped: true });
  process.env["DATABASE_URL"] = "postgresql://user:pass@localhost/db";
});

// ─── teardownApp ─────────────────────────────────────────────────────────────

describe("teardownApp", () => {
  it("returns early without touching infra when app is not found", async () => {
    vi.mocked(getAppById).mockResolvedValue(null);
    await teardownApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(deleteCloudRunService).not.toHaveBeenCalled();
    expect(unregisterShopifyWebhooks).not.toHaveBeenCalled();
  });

  it("unregisters webhooks, unschedules cron, deletes CR, deactivates DB", async () => {
    await teardownApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(unregisterShopifyWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: MOCK_APP.shopDomain }),
    );
    expect(unscheduleAppCron).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID }),
    );
    expect(deleteCloudRunService).toHaveBeenCalledWith(APP_ID);
    expect(deactivateAppInfrastructure).toHaveBeenCalledWith(APP_ID);
  });

  it("skips webhook unregister when app has none", async () => {
    vi.mocked(getActiveWebhookSubscriptionsForApp).mockResolvedValue([]);
    await teardownApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(unregisterShopifyWebhooks).not.toHaveBeenCalled();
    expect(deleteCloudRunService).toHaveBeenCalled(); // still proceeds
  });

  it("continues through all steps even when webhook unregister throws", async () => {
    vi.mocked(unregisterShopifyWebhooks).mockRejectedValue(new Error("Shopify 503"));
    await expect(teardownApp({ tenantId: TENANT_ID, appId: APP_ID })).resolves.not.toThrow();
    expect(deleteCloudRunService).toHaveBeenCalled();
    expect(deactivateAppInfrastructure).toHaveBeenCalled();
  });

  it("continues when Cloud Run delete fails", async () => {
    vi.mocked(deleteCloudRunService).mockRejectedValue(new Error("not found"));
    await expect(teardownApp({ tenantId: TENANT_ID, appId: APP_ID })).resolves.not.toThrow();
    expect(deactivateAppInfrastructure).toHaveBeenCalled();
  });
});

// ─── reactivateApp ───────────────────────────────────────────────────────────

describe("reactivateApp", () => {
  it("throws when app is not found", async () => {
    vi.mocked(getAppById).mockResolvedValue(null);
    await expect(reactivateApp({ tenantId: TENANT_ID, appId: APP_ID })).rejects.toThrow(APP_ID);
  });

  it("throws when no prior deploy exists", async () => {
    vi.mocked(getLatestDeployedVersionForApp).mockResolvedValue(null);
    await expect(reactivateApp({ tenantId: TENANT_ID, appId: APP_ID })).rejects.toThrow("no prior deploy");
  });

  it("throws when app has no handler_sa_email", async () => {
    vi.mocked(getAppById).mockResolvedValue({ ...MOCK_APP, handlerSaEmail: null } as never);
    await expect(reactivateApp({ tenantId: TENANT_ID, appId: APP_ID })).rejects.toThrow("handler_sa_email");
  });

  it("deploys the stored image — does NOT build a new one", async () => {
    await reactivateApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(deployToCloudRun).toHaveBeenCalledWith(
      expect.objectContaining({ imageName: expect.stringContaining("1.0.0") }),
    );
    // buildAndPushImage is not imported/called in lifecycle.ts
  });

  it("re-registers webhooks when the latest deploy had them", async () => {
    await reactivateApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(registerWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({ webhookTopics: ["orders/create"] }),
    );
  });

  it("skips webhook re-register when the latest deploy had none", async () => {
    vi.mocked(getLatestDeployedVersionForApp).mockResolvedValue({ ...MOCK_LATEST, webhookTopics: [] });
    await reactivateApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(registerWebhooks).not.toHaveBeenCalled();
  });

  it("re-asserts cron when the latest deploy had a schedule", async () => {
    await reactivateApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(scheduleAppCron).toHaveBeenCalledWith(
      expect.objectContaining({ cronExpression: "*/5 * * * *" }),
    );
  });

  it("skips cron when the latest deploy had none", async () => {
    vi.mocked(getLatestDeployedVersionForApp).mockResolvedValue({ ...MOCK_LATEST, cronSchedule: null });
    await reactivateApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(scheduleAppCron).not.toHaveBeenCalled();
  });

  it("returns functionUrl from deployToCloudRun", async () => {
    const result = await reactivateApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(result?.functionUrl).toBe("https://handler.run.app");
  });
});

// ─── permanentDeleteApp ──────────────────────────────────────────────────────

describe("permanentDeleteApp", () => {
  it("returns early without touching infra when app is not found", async () => {
    vi.mocked(getAppById).mockResolvedValue(null);
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(hardDeleteApp).not.toHaveBeenCalled();
    expect(deleteObjectsBatch).not.toHaveBeenCalled();
  });

  it("runs GCS batch delete BEFORE hardDeleteApp", async () => {
    const callOrder: string[] = [];
    vi.mocked(deleteObjectsBatch).mockImplementation(async () => {
      callOrder.push("gcs");
      return { deleted: 1, failed: 0 } as never;
    });
    vi.mocked(hardDeleteApp).mockImplementation(async () => {
      callOrder.push("db");
    });

    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });

    expect(callOrder.indexOf("gcs")).toBeLessThan(callOrder.indexOf("db"));
  });

  it("deletes all historical Docker images", async () => {
    vi.mocked(getAppVersionSemvers).mockResolvedValue(["1.0.0", "0.9.0", "0.8.0"]);
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(deleteDockerImage).toHaveBeenCalledTimes(3);
  });

  it("deletes the per-app SA when handlerSaEmail is set", async () => {
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(deleteServiceAccount).toHaveBeenCalledWith(
      expect.stringContaining("h-acme-1"),
    );
  });

  it("skips SA delete when handlerSaEmail is null", async () => {
    vi.mocked(getAppById).mockResolvedValue({ ...MOCK_APP, handlerSaEmail: null } as never);
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(deleteServiceAccount).not.toHaveBeenCalled();
  });

  it("drops the app Postgres schema", async () => {
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(dropAppSchema).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSchema: expect.stringMatching(/^tenant_/) }),
    );
  });

  it("always calls hardDeleteApp — it is the authoritative cleanup step", async () => {
    // Even if GCS batch delete throws, DB hard-delete must run.
    vi.mocked(deleteObjectsBatch).mockRejectedValue(new Error("GCS outage"));
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(hardDeleteApp).toHaveBeenCalledWith(APP_ID);
  });

  it("non-fatal failures in early steps do not skip later steps", async () => {
    vi.mocked(unregisterShopifyWebhooks).mockRejectedValue(new Error("Shopify 503"));
    vi.mocked(deleteCloudRunService).mockRejectedValue(new Error("CR gone"));
    vi.mocked(deleteServiceAccount).mockRejectedValue(new Error("SA gone"));
    vi.mocked(deleteDockerImage).mockRejectedValue(new Error("image gone"));
    vi.mocked(dropAppSchema).mockRejectedValue(new Error("schema gone"));
    await permanentDeleteApp({ tenantId: TENANT_ID, appId: APP_ID });
    expect(hardDeleteApp).toHaveBeenCalled(); // still runs
  });
});
