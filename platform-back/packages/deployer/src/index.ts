// Public surface of @platform-back/deployer. Each sub-phase adds to this
// barrel; the orchestrator (sub-phase D) ties them together.

export {
  cloudRunServiceName,
  cloudRunServicePath,
  dockerImageName,
  handlerSaEmail,
  handlerSaLocalPart,
  sanitizeShopPrefix,
  GCP_PROJECT_VALUE,
  GCP_REGION_VALUE,
  DOCKER_REGISTRY_VALUE,
} from "./service-namer.js";

export {
  deployToCloudRun,
  deleteCloudRunService,
  type CloudRunDeployInput,
  type CloudRunDeployResult,
} from "./cloud-run-ops.js";

export { buildAndPushImage, type BuildImageInput, type BuildImageResult } from "./build-image.js";

export {
  writeHandlerSaEmail,
  upsertDeployedFunction,
  type UpsertDeployedFunctionInput,
} from "./db-writer.js";

export {
  createServiceAccount,
  deleteServiceAccount,
  grantCloudRunInvoker,
  type CreateServiceAccountInput,
  type CreateServiceAccountResult,
} from "./iam-ops.js";

export {
  provisionHandlerSa,
  grantPlatformBackInvokerOnHandler,
  nextHandlerSaCounter,
  type ProvisionHandlerSaInput,
  type ProvisionHandlerSaResult,
} from "./sa-provisioner.js";

export {
  assembleBuildContext,
  type AssembleBuildContextInput,
  type AssembleBuildContextResult,
  type GeneratedFile,
} from "./build-context.js";

export {
  runMigrations,
  appSchemaName,
  dropAppSchema,
  type RunMigrationsInput,
  type DropAppSchemaInput,
} from "./migration-runner.js";

export { validateMigrationSql, makeIdempotent } from "./sql-validator.js";

export {
  startDeploy,
  getDeployJob,
  subscribeDeployJob,
  DEPLOY_STEPS,
  type DeployStep,
  type DeployStepStatus,
  type DeployStepState,
  type DeployJobStatus,
  type DeployJobEvent,
  type StartDeployInput,
} from "./orchestrator.js";

export {
  scheduleAppCron,
  unscheduleAppCron,
  type ScheduleAppCronInput,
  type UnscheduleAppCronInput,
} from "./cron-scheduler.js";

export {
  registerWebhooks,
  reregisterTenantWebhooks,
  unregisterShopifyWebhooks,
  type RegisterWebhooksInput,
  type UnregisterShopifyWebhooksInput,
} from "./webhook-registrar.js";

export { deleteDockerImage } from "./build-image.js";

export {
  teardownApp,
  reactivateApp,
  permanentDeleteApp,
  type TeardownAppInput,
  type ReactivateAppInput,
  type PermanentDeleteAppInput,
} from "./lifecycle.js";
