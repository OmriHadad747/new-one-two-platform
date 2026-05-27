import type { JobsMap } from "../lib/cron-runner.js";

// Template stub — present so server.ts's dynamic import type-resolves at
// build time even on handlers that declare no cron schedule.
//
// Apps with cron: the generator REPLACES this file with a real jobs map.
// Apps without cron: this file ships as-is; ENABLE_CRON_RUNNER stays false
// so the cron runner never reads it.

export const jobs: JobsMap = {};
