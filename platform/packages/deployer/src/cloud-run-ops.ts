import { ServicesClient } from "@google-cloud/run";
import { logger } from "@new-one-two/logger";
import {
  cloudRunServiceName,
  cloudRunParent,
  cloudRunServicePath,
  GCP_REGION_VALUE,
  GCP_PROJECT_VALUE,
} from "./service-namer.js";

const client = new ServicesClient();

function buildServiceSpec(
  appId: string,
  imageName: string,
  envVars: Record<string, string>
) {
  return {
    template: {
      containers: [
        {
          image: imageName,
          env: Object.entries(envVars).map(([name, value]) => ({ name, value })),
          resources: {
            limits: { memory: "256Mi", cpu: "1" },
          },
        },
      ],
      timeout: { seconds: "30" },
      maxInstanceRequestConcurrency: 1,
    },
    ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" as const,
  };
}

export async function deployToCloudRun(
  appId: string,
  imageName: string,
  envVars: Record<string, string>
): Promise<{ functionUrl: string }> {
  const serviceName = cloudRunServiceName(appId);
  const parent = cloudRunParent();
  const serviceId = serviceName;

  logger.info({ appId, imageName, region: GCP_REGION_VALUE }, "Deploying to Cloud Run");

  const serviceSpec = buildServiceSpec(appId, imageName, envVars);

  let serviceUrl: string;

  try {
    // Try to update existing service
    const [operation] = await client.updateService({
      service: {
        name: cloudRunServicePath(appId),
        ...serviceSpec,
      },
    });
    const [service] = await operation.promise();
    serviceUrl = service.uri ?? "";
    logger.info({ appId, serviceUrl }, "Cloud Run service updated");
  } catch (err: unknown) {
    // If service doesn't exist, create it
    const code = (err as { code?: number }).code;
    if (code !== 5 /* NOT_FOUND */) throw err;

    const [operation] = await client.createService({
      parent,
      serviceId,
      service: serviceSpec,
    });
    const [service] = await operation.promise();
    serviceUrl = service.uri ?? "";
    logger.info({ appId, serviceUrl, project: GCP_PROJECT_VALUE }, "Cloud Run service created");
  }

  if (!serviceUrl) {
    throw new Error(`Cloud Run service for app ${appId} has no URI after deployment`);
  }

  // Append /invoke path so the worker can POST directly to this URL
  return { functionUrl: `${serviceUrl}/invoke` };
}
