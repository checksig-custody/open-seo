import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { trackedKeywords } from "./search-intelligence-p2.schema";

/**
 * A measured search volume, kept as history.
 *
 * `tracked_keywords.search_volume` stays the read model that Keyword Gap and
 * Share of Search weight by; this is the measurement behind it — when it was
 * taken, from which market, by which provider, and whether the provider
 * actually answered. A null volume here is "not told", never "zero".
 */
export const siKeywordVolumeSnapshots = sqliteTable(
  "si_keyword_volume_snapshots",
  {
    id: text("id").primaryKey(),
    trackedKeywordId: text("tracked_keyword_id")
      .notNull()
      .references(() => trackedKeywords.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    searchEngine: text("search_engine").notNull().default("google"),
    /** NULL = the provider did not say. 0 = the provider said zero. */
    searchVolume: integer("search_volume"),
    competition: real("competition"),
    competitionLevel: text("competition_level"),
    /** Integer micro-USD, like every other money column in this engine. */
    costPerClickMicros: integer("cost_per_click_micros"),
    keywordDifficulty: integer("keyword_difficulty"),
    searchIntent: text("search_intent"),
    provider: text("provider").notNull(),
    source: text("source", { enum: ["dataforseo", "fixture"] }).notNull(),
    collectedAt: text("collected_at").notNull(),
    collectionWindow: text("collection_window").notNull(),
    snapshotStatus: text("snapshot_status", {
      enum: ["complete", "partial", "no_data"],
    })
      .notNull()
      .default("complete"),
    snapshotStatusReason: text("snapshot_status_reason"),
    /** The operation that paid for it, so a volume traces to its cost. */
    jobId: text("job_id"),
    providerResponseId: text("provider_response_id"),
    /** `keyword|location|language|engine|window`. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("si_keyword_volume_dedupe_idx").on(table.dedupeKey),
    index("si_keyword_volume_keyword_idx").on(
      table.trackedKeywordId,
      table.collectedAt,
    ),
    index("si_keyword_volume_window_idx").on(table.collectionWindow),
  ],
);
