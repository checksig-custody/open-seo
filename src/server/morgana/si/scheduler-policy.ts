/**
 * Search Intelligence Budget V2 scheduling policy.
 *
 * This is deliberately data-only. Collectors consume these intervals but never
 * decide a budget independently: every paid operation still goes through the
 * global reservation authority.
 */
export const RANK_FREQUENCY_HOURS = {
  critical: 6,
  high: 12,
  normal: 24,
  low: 72,
} as const;

export const DOMAIN_OVERVIEW_FREQUENCY_HOURS = 24;
export const BACKLINK_FREQUENCY_HOURS = 7 * 24;
export const KEYWORD_VOLUME_FREQUENCY_DAYS = 30;
export const SITE_AUDIT_FREQUENCY_HOURS = 7 * 24;

/** Budget V2 is a target/envelope/cap, not an invitation to spend the cap. */
export const BUDGET_V2 = {
  operatingTargetMicros: 8_000_000,
  softMonthlyMicros: 10_000_000,
  hardMonthlyMicros: 20_000_000,
  hardDailyMicros: 1_000_000,
} as const;
