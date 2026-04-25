import { ServicesClient } from "@google-cloud/run";
import { logger } from "@platform-back/logger";
import {
  cloudRunParent,
  cloudRunServiceName,
  cloudRunServicePath,
  GCP_PROJECT_VALUE,
  GCP_REGION_VALUE,
} from "./service-namer.js";

// Wraps Cloud Run's Admin API. We deploy with `--no-allow-unauthenticated`
// (no public ingress without a verified SA) and bind the per-handler SA
// so inbound requests are signed by an identity platform-back can verify.
//
// Update-or-create: try update first, fall through to create on NOT_FOUND.
// Cloud Run treats these as the same resource — re-deploys hit update.

const client = new ServicesClient();

export interface CloudRunDeployInput {
  appId: string;
  imageName: string;
  serviceAccountEmail: string;
  envVars: Record<string, string>;
  memoryMb?: number;
  cpu?: string;
  timeoutSec?: number;
  concurrency?: number;
  /** Per locked decision 7: widget-bearing handlers pin to 1 instance. */
  minInstances?: number;
  maxInstances?: number;
}

export interface CloudRunDeployResult {
  functionUrl: string;
  serviceName: string;
}

function buildServiceSpec(input: CloudRunDeployInput) {
  const memoryMb = input.memoryMb ?? 256;
  const cpu = input.cpu ?? "1";
  const timeoutSec = input.timeoutSec ?? 30;
  const concurrency = input.concurrency ?? 80;
  const minInstances = input.minInstances ?? 0;
  const maxInstances = input.maxInstances ?? 10;

  return {
    template: {
      serviceAccount: input.serviceAccountEmail,
      containers: [
        {
          image: input.imageName,
          env: Object.entries(input.envVars).map(([name, value]) => ({
            name,
            value,
          })),
          resources: {
            limits: { memory: `${memoryMb}Mi`, cpu },
          },
        },
      ],
      timeout: { seconds: String(timeoutSec) },
      maxInstanceRequestConcurrency: concurrency,
      scaling: {
        minInstanceCount: minInstances,
        maxInstanceCount: maxInstances,
      },
    },
    // Handlers are internal-only: all callers (api, worker) run inside
    // the platform-connector VPC. No external party ever calls a handler
    // URL directly — Shopify hits webhook-gateway, browsers hit api.
    // INGRESS_TRAFFIC_INTERNAL blocks internet traffic at Google's network
    // edge before IAM even runs, giving us defence-in-depth on top of the
    // roles/run.invoker check enforced per handler (see sa-provisioner).
    ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" as const,
  };
}

export async function deployToCloudRun(input: CloudRunDeployInput): Promise<CloudRunDeployResult> {
  const serviceName = cloudRunServiceName(input.appId);
  const parent = cloudRunParent();
  const spec = buildServiceSpec(input);

  logger.info(
    {
      appId: input.appId,
      imageName: input.imageName,
      serviceAccountEmail: input.serviceAccountEmail,
      project: GCP_PROJECT_VALUE,
      region: GCP_REGION_VALUE,
    },
    "Deploying to Cloud Run",
  );

  let serviceUrl: string;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [operation] = await (client.updateService as any)({
      service: { name: cloudRunServicePath(input.appId), ...spec },
    });
    const svc = await (operation as { promise(): Promise<{ uri?: string }> }).promise();
    serviceUrl = svc.uri ?? "";
    logger.info({ appId: input.appId, serviceUrl }, "Cloud Run service updated");
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 5 /* NOT_FOUND */) throw err;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [operation] = await (client.createService as any)({
      parent,
      serviceId: serviceName,
      service: spec,
    });
    const svc = await (operation as { promise(): Promise<{ uri?: string }> }).promise();
    serviceUrl = svc.uri ?? "";
    logger.info({ appId: input.appId, serviceUrl }, "Cloud Run service created");
  }

  if (!serviceUrl) {
    throw new Error(`Cloud Run service for app ${input.appId} has no URI after deployment`);
  }

  return { functionUrl: serviceUrl, serviceName };
}

export async function deleteCloudRunService(appId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [operation] = await (client.deleteService as any)({
      name: cloudRunServicePath(appId),
    });
    await (operation as { promise(): Promise<unknown> }).promise();
    logger.info({ appId }, "Cloud Run service deleted");
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 5 /* NOT_FOUND */) {
      logger.info({ appId }, "Cloud Run service already gone — skipping delete");
      return;
    }
    throw err;
  }
}
