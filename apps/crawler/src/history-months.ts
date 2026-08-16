import { getJstYearMonthKey, shiftYearMonthKey } from "@mf-dashboard/date-utils";

/**
 * Defensive upper bound only. History mode stops when the Money Forward UI no
 * longer changes month; this prevents a broken UI from looping forever without
 * imposing a normal-user history cutoff. 20 years is deliberately generous.
 */
export const DEFAULT_HISTORY_MAX_MONTHS = 240;

/**
 * History mode fetches months by calendar month, not by day offset.
 * Using Date#setMonth on month-end dates can roll over to the wrong month
 * (e.g. 2026-03-31 minus 1 month becomes 2026-03-03).
 * Money Forward dates are handled in Japan time even when CI runs in UTC.
 */
export function getHistoryMonth(now: Date, monthsAgo: number): string {
  return getHistoryMonthFromAnchor(getJstYearMonthKey(now), monthsAgo);
}

export function getHistoryMaxMonths(now: Date): number {
  return getHistoryMaxMonthsFromAnchor(getJstYearMonthKey(now));
}

export function getHistoryMonthFromAnchor(anchorMonth: string, monthsAgo: number): string {
  return shiftYearMonthKey(anchorMonth, -monthsAgo);
}

export function getHistoryMaxMonthsFromAnchor(anchorMonth: string): number {
  // Validate the anchor even though it does not determine the cap anymore.
  shiftYearMonthKey(anchorMonth, 0);
  return DEFAULT_HISTORY_MAX_MONTHS;
}

export function parseHistoryMaxMonths(value: string | undefined): number {
  if (!value) return DEFAULT_HISTORY_MAX_MONTHS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HISTORY_MAX_MONTHS;
}

/** Returns false for the UI stop condition, and throws on skipped/non-monthly progress. */
export function validateHistoryMonthProgression(currentMonth: string, nextMonth: string): boolean {
  const expectedPreviousMonth = shiftYearMonthKey(currentMonth, -1);
  if (nextMonth === currentMonth) return false;
  if (nextMonth !== expectedPreviousMonth) {
    throw new Error(
      `Unexpected cash flow month progression: ${currentMonth} -> ${nextMonth}; expected ${expectedPreviousMonth}`,
    );
  }
  return true;
}
