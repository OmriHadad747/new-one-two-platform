import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/deployer",
  "packages/email",
  "apps/api",
]);
