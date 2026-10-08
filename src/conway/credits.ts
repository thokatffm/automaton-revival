/**
 * Conway Credits Management
 *
 * Monitors the automaton's compute credit balance and triggers
 * survival mode transitions.
 */

import type {
  ConwayClient,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(
  conway: ConwayClient,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = await conway.getCreditsBalance();

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on current credits.
 * Thresholds are checked in descending order: high > normal > low_compute > critical > dead.
 *
 * Zero credits = "critical" (broke but alive — can still accept funding, send distress).
 * Only negative balance (API-confirmed debt) = "dead".
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents > SURVIVAL_THRESHOLDS.high) return "high";
  if (creditsCents > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (creditsCents > SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (creditsCents >= 0) return "critical";
  return "dead";
}

/**
 * Sentinel used when the balance API is unreachable and no cached balance
 * exists. It is deliberately NOT a real balance: "unknown" must never be
 * read as the API-confirmed debt that getSurvivalTier() treats as "dead".
 */
export const BALANCE_UNKNOWN = -1;

/**
 * Map a possibly-unknown balance to a survival tier.
 *
 * When the balance is unknown the automaton degrades to "low_compute"
 * instead of dying: an unreachable billing API is an infrastructure
 * failure, not evidence that the agent is out of money. Retried next tick.
 */
export function resolveSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents === BALANCE_UNKNOWN) return "low_compute";
  return getSurvivalTier(creditsCents);
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
