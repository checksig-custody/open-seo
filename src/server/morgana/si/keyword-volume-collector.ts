import { z } from "zod";
import { loadDataforseoSections } from "@/server/lib/dataforseo/client";
import {
  accountFor,
  readProviderCost,
  type CollectionAccounting,
} from "./collection-accounting";
import { classifyProviderError, type TypedFailure } from "./rank-errors";

/**
 * Morgana Search Intelligence — the live search-volume collector.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * A thin adapter over `fetchKeywordOverview`, for the same reasons as the other
 * two collectors: the transport, the retry policy and the credential lookup
 * already exist under `src/server/lib/dataforseo/`, and `runtime-env.ts` points
 * this engine at its own DataForSEO account.
 *
 * ONE CALL FOR THE WHOLE BATCH. Labs' Keyword Overview accepts a list and is
 * priced per request, not per keyword, so nine keywords cost what one costs.
 * Splitting them would multiply the bill for no additional data.
 *
 * THE RULE THAT SHAPES EVERY LINE BELOW: a volume the provider did not state is
 * `null`, and a volume it stated as zero is `0`. They are different facts — one
 * says "we do not know", the other says "nobody searches this" — and the
 * difference decides whether a keyword may carry weight in Share of Search. A
 * `??` to zero anywhere in this file would silently convert the first into the
 * second, which is the failure this collector exists to avoid.
 */

/** Labs Keyword Overview. Priced per request; the batch size does not change it. */
export const KEYWORD_OVERVIEW_ENDPOINT =
  "v3/dataforseo_labs/google/keyword_overview/live";

/**
 * The most a single Keyword Overview request could plausibly cost, in µUSD.
 *
 * The headroom test, as everywhere else: the provider states its charge only in
 * the response, so before the call the only safe question is "if this costs the
 * most it plausibly could, are we still inside the cap". Deliberately several
 * times the observed Labs list price.
 */
export const WORST_CASE_OVERVIEW_MICROS = 30_000;

interface KeywordVolumeRow {
  keyword: string;
  /** `null` = the provider did not say. `0` = the provider said zero. */
  searchVolume: number | null;
  competition: number | null;
  competitionLevel: string | null;
  costPerClickMicros: number | null;
  keywordDifficulty: number | null;
  searchIntent: string | null;
  /** `complete` when the provider answered, `no_data` when it knows nothing. */
  snapshotStatus: "complete" | "no_data";
  snapshotStatusReason: string | null;
}

type CollectOutcome =
  | {
      status: "completed";
      rows: KeywordVolumeRow[];
      accounting: CollectionAccounting;
      endpoint: string;
    }
  | {
      status: "failed";
      failure: TypedFailure;
      accounting: CollectionAccounting;
    };

/**
 * The provider payload, validated at the boundary rather than cast through it.
 *
 * `.catch(null)` on every field is the null/zero rule expressed as a schema: a
 * value that is not the shape we expect becomes "not stated", never a number.
 * A string volume, a NaN CPC and a competition of 42 are all absent data, and
 * the schema says so once instead of every reader remembering to check.
 */
const overviewItemSchema = z.object({
  keyword: z.string().trim().min(1).nullable().catch(null),
  keyword_info: z
    .object({
      search_volume: z.number().int().nonnegative().nullable().catch(null),
      cpc: z.number().nonnegative().nullable().catch(null),
      competition: z.number().min(0).max(1).nullable().catch(null),
      competition_level: z.string().trim().min(1).nullable().catch(null),
    })
    .catch({
      search_volume: null,
      cpc: null,
      competition: null,
      competition_level: null,
    }),
  keyword_properties: z
    .object({
      keyword_difficulty: z.number().int().nonnegative().nullable().catch(null),
    })
    .catch({ keyword_difficulty: null }),
  search_intent_info: z
    .object({ main_intent: z.string().trim().min(1).nullable().catch(null) })
    .catch({ main_intent: null }),
});

type OverviewItem = z.infer<typeof overviewItemSchema>;

/** What an unparseable item means: nothing stated, about anything. */
const NOTHING_STATED: OverviewItem = {
  keyword: null,
  keyword_info: {
    search_volume: null,
    cpc: null,
    competition: null,
    competition_level: null,
  },
  keyword_properties: { keyword_difficulty: null },
  search_intent_info: { main_intent: null },
};

/** USD as the provider states it, converted to the engine's integer µUSD. */
function usdToMicrosOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1_000_000);
}

/**
 * Read one provider item into a row.
 *
 * Exported for the tests, because the null/zero distinction is the whole
 * contract of this module and deserves to be assertable without a network
 * boundary in the way.
 */
export function normalizeOverviewItem(
  item: unknown,
  requestedKeyword: string,
): KeywordVolumeRow {
  const parsed = overviewItemSchema.safeParse(item);
  const record = parsed.success ? parsed.data : NOTHING_STATED;

  const searchVolume = record.keyword_info.search_volume;
  // The provider answered about this keyword but has no volume for it. That is
  // a real answer — "we hold no data" — and not the same as a volume of zero,
  // so it is recorded as a status rather than as a number.
  const noData = searchVolume === null;

  return {
    keyword: record.keyword ?? requestedKeyword,
    searchVolume,
    competition: record.keyword_info.competition,
    competitionLevel: record.keyword_info.competition_level,
    costPerClickMicros: usdToMicrosOrNull(record.keyword_info.cpc),
    keywordDifficulty: record.keyword_properties.keyword_difficulty,
    searchIntent: record.search_intent_info.main_intent,
    snapshotStatus: noData ? "no_data" : "complete",
    snapshotStatusReason: noData
      ? "provider returned no search volume for this keyword"
      : null,
  };
}

/**
 * Buy one Keyword Overview for a batch of keywords.
 *
 * Throws nothing: a provider failure comes back as a typed failure with the
 * request still accounted, because the call happened and may have been charged.
 * An error must never be mistaken for a batch of zero volumes.
 */
export async function collectKeywordVolumes(input: {
  keywords: readonly string[];
  locationCode: number;
  languageCode: string;
}): Promise<CollectOutcome> {
  if (input.keywords.length === 0) {
    return {
      status: "completed",
      rows: [],
      accounting: accountFor([], { metered: false, paidSubmission: false }),
      endpoint: KEYWORD_OVERVIEW_ENDPOINT,
    };
  }

  try {
    const sections = await loadDataforseoSections();
    const response = await sections.fetchKeywordOverview({
      keywords: [...input.keywords],
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    });

    const cost = readProviderCost(response.billing);
    const endpoint = response.billing.path.join("/");
    const accounting = accountFor([{ endpointPath: endpoint, cost }], {
      metered: true,
      paidSubmission: true,
    });

    // Match the response back to what was asked for, by keyword. A provider
    // that answers about eight of nine keywords must leave the ninth absent,
    // not zeroed — the caller records only what came back.
    const byKeyword = new Map<string, unknown>();
    for (const item of response.data) {
      const parsed = overviewItemSchema.safeParse(item);
      const keyword = parsed.success ? parsed.data.keyword : null;
      if (keyword) byKeyword.set(keyword.toLowerCase(), item);
    }

    const rows = input.keywords.flatMap((keyword) => {
      const item = byKeyword.get(keyword.toLowerCase());
      return item === undefined ? [] : [normalizeOverviewItem(item, keyword)];
    });

    return { status: "completed", rows, accounting, endpoint };
  } catch (error) {
    // Charged or not, we cannot see which, so the request is counted with its
    // cost NOT reported: visible as a call, absent from the money column.
    const accounting = accountFor(
      [
        {
          endpointPath: KEYWORD_OVERVIEW_ENDPOINT,
          cost: { micros: null, status: "not_reported" },
        },
      ],
      { metered: true, paidSubmission: true },
    );
    return {
      status: "failed",
      failure: classifyProviderError(error, KEYWORD_OVERVIEW_ENDPOINT),
      accounting,
    };
  }
}
