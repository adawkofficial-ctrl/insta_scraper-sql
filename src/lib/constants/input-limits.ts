/**
 * Discovery "results wanted" / maxLeads bounds.
 * This is input validation, not a budget cap.
 */
export const DEFAULT_MAX_RESULTS_WANTED = 5000;
export const CONFIRM_RESULTS_ABOVE = 1000;

export function getMaxResultsWanted(): number {
  const raw = process.env.MAX_RESULTS_WANTED;
  if (!raw) return DEFAULT_MAX_RESULTS_WANTED;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_RESULTS_WANTED;
}
