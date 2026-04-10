/**
 * Re-exports plan definitions from the shared types package.
 * All plan data lives in @new-one-two/types so gateway, harness, and frontend
 * can import it without depending on the API package.
 */
export { PLANS, getPlanLimits, getAllPlans } from "@new-one-two/types";
export type { BillingPlan, PlanDefinition, PlanLimits } from "@new-one-two/types";

import { PLANS } from "@new-one-two/types";
import type { BillingPlan } from "@new-one-two/types";

/** Returns true if the given plan allows the specified app archetype. */
export function isPlanAllowedCategory(
  plan: BillingPlan,
  archetype: string
): boolean {
  return PLANS[plan].limits.allowedCategories.includes(archetype);
}
