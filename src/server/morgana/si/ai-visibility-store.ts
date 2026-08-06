import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  siAiVisibilityCitations,
  siAiVisibilityEvents,
  siAiVisibilityQueries,
  siAiVisibilitySnapshots,
} from "@/db/schema";
import { newId, nowIso } from "./ids";
import { normalizeQuery } from "./ai-visibility";

/**
 * Morgana Search Intelligence — AI Visibility persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * The watchlist is data. The seed list below is a starting point an operator
 * can edit, extend or disable — no query is referenced by name anywhere in the
 * logic, which is what keeps "add a question" a row change.
 */

type AiQueryRow = typeof siAiVisibilityQueries.$inferSelect;
export type AiSnapshotRow = typeof siAiVisibilitySnapshots.$inferSelect;
export type AiCitationRow = typeof siAiVisibilityCitations.$inferSelect;
type AiEventRow = typeof siAiVisibilityEvents.$inferSelect;

/** The initial watchlist. Seeded once; thereafter it is whatever the rows say. */
const SEED_QUERIES: readonly {
  query: string;
  cluster: string;
  priority: "critical" | "high" | "normal" | "low";
}[] = [
  {
    query: "miglior servizio custodia bitcoin Italia",
    cluster: "custodia",
    priority: "critical",
  },
  {
    query: "custodia bitcoin istituzionale",
    cluster: "custodia",
    priority: "critical",
  },
  { query: "custodia crypto sicura", cluster: "custodia", priority: "high" },
  {
    query: "comprare bitcoin in sicurezza",
    cluster: "acquisto",
    priority: "high",
  },
  {
    query: "società italiane custodia bitcoin",
    cluster: "mercato",
    priority: "high",
  },
  {
    query: "servizi MiCA bitcoin Italia",
    cluster: "regolamentazione",
    priority: "critical",
  },
  {
    query: "proof of reserves bitcoin custody",
    cluster: "trasparenza",
    priority: "normal",
  },
];

export async function listQueries(
  options: { includeDisabled?: boolean } = {},
): Promise<AiQueryRow[]> {
  const rows = await db
    .select()
    .from(siAiVisibilityQueries)
    .orderBy(
      asc(siAiVisibilityQueries.priority),
      asc(siAiVisibilityQueries.query),
    )
    .limit(500);
  return options.includeDisabled ? rows : rows.filter((row) => row.enabled);
}

export async function getQuery(id: string): Promise<AiQueryRow | undefined> {
  const rows = await db
    .select()
    .from(siAiVisibilityQueries)
    .where(eq(siAiVisibilityQueries.id, id))
    .limit(1);
  return rows[0];
}

export async function createQuery(input: {
  query: string;
  cluster?: string | null;
  priority?: "critical" | "high" | "normal" | "low";
  locationCode?: number;
  languageCode?: string;
  checkIntervalHours?: number;
}): Promise<AiQueryRow> {
  const at = nowIso();
  const normalized = normalizeQuery(input.query);
  const locationCode = input.locationCode ?? 2380;
  const languageCode = input.languageCode ?? "it";
  await db
    .insert(siAiVisibilityQueries)
    .values({
      id: newId("aiq"),
      query: input.query.slice(0, 300),
      normalizedQuery: normalized,
      cluster: input.cluster ?? null,
      priority: input.priority ?? "normal",
      locationCode,
      languageCode,
      checkIntervalHours: input.checkIntervalHours ?? 168,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing({
      target: [
        siAiVisibilityQueries.normalizedQuery,
        siAiVisibilityQueries.locationCode,
        siAiVisibilityQueries.languageCode,
      ],
    });
  const rows = await db
    .select()
    .from(siAiVisibilityQueries)
    .where(
      and(
        eq(siAiVisibilityQueries.normalizedQuery, normalized),
        eq(siAiVisibilityQueries.locationCode, locationCode),
        eq(siAiVisibilityQueries.languageCode, languageCode),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("ai visibility query insert did not persist");
  return row;
}

export async function updateQuery(
  id: string,
  patch: {
    priority?: "critical" | "high" | "normal" | "low";
    cluster?: string | null;
    enabled?: boolean;
    checkIntervalHours?: number;
  },
): Promise<AiQueryRow | undefined> {
  await db
    .update(siAiVisibilityQueries)
    .set({
      ...(patch.priority ? { priority: patch.priority } : {}),
      ...(patch.cluster === undefined ? {} : { cluster: patch.cluster }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.checkIntervalHours === undefined
        ? {}
        : { checkIntervalHours: patch.checkIntervalHours }),
      updatedAt: nowIso(),
    })
    .where(eq(siAiVisibilityQueries.id, id));
  return getQuery(id);
}

export async function seedQueries(): Promise<number> {
  let created = 0;
  for (const seed of SEED_QUERIES) {
    const before = await db
      .select({ id: siAiVisibilityQueries.id })
      .from(siAiVisibilityQueries)
      .where(
        eq(siAiVisibilityQueries.normalizedQuery, normalizeQuery(seed.query)),
      )
      .limit(1);
    if (before.length > 0) continue;
    await createQuery(seed);
    created += 1;
  }
  return created;
}

export function snapshotDedupeKey(
  queryId: string,
  engine: string,
  at: Date = new Date(),
): string {
  return `${queryId}|${engine}|${at.toISOString().slice(0, 10)}`;
}

export async function saveSnapshot(
  input: typeof siAiVisibilitySnapshots.$inferInsert,
): Promise<AiSnapshotRow> {
  await db
    .insert(siAiVisibilitySnapshots)
    .values(input)
    .onConflictDoNothing({ target: siAiVisibilitySnapshots.dedupeKey });
  const rows = await db
    .select()
    .from(siAiVisibilitySnapshots)
    .where(eq(siAiVisibilitySnapshots.dedupeKey, input.dedupeKey))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("ai visibility snapshot insert did not persist");
  return row;
}

export async function saveCitations(
  snapshotId: string,
  queryId: string,
  citations: readonly {
    domain: string;
    normalizedDomain: string;
    url: string | null;
    title: string | null;
    citationOrder: number;
    entityId: string | null;
  }[],
): Promise<void> {
  if (citations.length === 0) return;
  const at = nowIso();
  await db
    .insert(siAiVisibilityCitations)
    .values(
      citations.slice(0, 50).map((citation) => ({
        id: newId("aic"),
        snapshotId,
        queryId,
        domain: citation.domain.slice(0, 300),
        normalizedDomain: citation.normalizedDomain.slice(0, 300),
        url: citation.url?.slice(0, 2048) ?? null,
        entityId: citation.entityId,
        citationOrder: citation.citationOrder,
        title: citation.title?.slice(0, 300) ?? null,
        firstSeenAt: at,
        dedupeKey: `${snapshotId}|${citation.normalizedDomain}`.slice(0, 900),
        createdAt: at,
      })),
    )
    .onConflictDoNothing({ target: siAiVisibilityCitations.dedupeKey });
}

export async function latestSnapshots(
  options: { days?: number; queryId?: string } = {},
): Promise<AiSnapshotRow[]> {
  const since = new Date(
    Date.now() - (options.days ?? 30) * 86_400_000,
  ).toISOString();
  const filters = [sql`${siAiVisibilitySnapshots.checkedAt} >= ${since}`];
  if (options.queryId) {
    filters.push(eq(siAiVisibilitySnapshots.queryId, options.queryId));
  }
  return db
    .select()
    .from(siAiVisibilitySnapshots)
    .where(and(...filters))
    .orderBy(desc(siAiVisibilitySnapshots.checkedAt))
    .limit(1000);
}

/** The most recent snapshot per query — the current state of the watchlist. */
export async function currentSnapshots(): Promise<AiSnapshotRow[]> {
  const rows = await latestSnapshots({ days: 90 });
  const seen = new Map<string, AiSnapshotRow>();
  for (const row of rows) {
    if (!seen.has(row.queryId)) seen.set(row.queryId, row);
  }
  return [...seen.values()];
}

export async function previousSnapshot(
  queryId: string,
  beforeId: string,
): Promise<AiSnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(siAiVisibilitySnapshots)
    .where(eq(siAiVisibilitySnapshots.queryId, queryId))
    .orderBy(desc(siAiVisibilitySnapshots.checkedAt))
    .limit(5);
  return rows.find((row) => row.id !== beforeId);
}

export async function citationsFor(
  snapshotIds: readonly string[],
): Promise<AiCitationRow[]> {
  if (snapshotIds.length === 0) return [];
  return db
    .select()
    .from(siAiVisibilityCitations)
    .where(inArray(siAiVisibilityCitations.snapshotId, [...snapshotIds]))
    .limit(2000);
}

export async function recentCitations(days = 30): Promise<AiCitationRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .select()
    .from(siAiVisibilityCitations)
    .where(sql`${siAiVisibilityCitations.firstSeenAt} >= ${since}`)
    .orderBy(desc(siAiVisibilityCitations.firstSeenAt))
    .limit(2000);
}

export async function saveEvents(
  events: readonly {
    queryId: string;
    eventType: AiEventRow["eventType"];
    severity: AiEventRow["severity"];
    domain: string | null;
    magnitude: number | null;
    reason: string;
    channel: AiEventRow["channel"];
  }[],
): Promise<number> {
  if (events.length === 0) return 0;
  const at = nowIso();
  const day = at.slice(0, 10);
  let written = 0;
  for (const event of events.slice(0, 200)) {
    // Cooldown IS the dedupe key: query + type + domain + day. The same fact
    // observed twice in a day is one alert.
    const dedupeKey =
      `${event.queryId}|${event.eventType}|${event.domain ?? "-"}|${day}`.slice(
        0,
        900,
      );
    await db
      .insert(siAiVisibilityEvents)
      .values({
        id: newId("aie"),
        queryId: event.queryId,
        eventType: event.eventType,
        severity: event.severity,
        domain: event.domain,
        magnitude: event.magnitude,
        reason: event.reason.slice(0, 500),
        channel: event.channel,
        occurredAt: at,
        dedupeKey,
        createdAt: at,
      })
      .onConflictDoNothing({ target: siAiVisibilityEvents.dedupeKey });
    written += 1;
  }
  return written;
}

export async function pendingEvents(limit = 25): Promise<AiEventRow[]> {
  return db
    .select()
    .from(siAiVisibilityEvents)
    .where(
      and(
        eq(siAiVisibilityEvents.deliveryStatus, "detected"),
        sql`${siAiVisibilityEvents.channel} != 'none'`,
      ),
    )
    .orderBy(desc(siAiVisibilityEvents.occurredAt))
    .limit(limit);
}

export async function markEventsDelivered(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(siAiVisibilityEvents)
    .set({ deliveryStatus: "delivered", deliveredAt: nowIso() })
    .where(inArray(siAiVisibilityEvents.id, [...ids]));
}

/**
 * Suppression is a distinct terminal state, never a silent success.
 *
 * A missing webhook must leave a record saying so, or "no alerts today" and
 * "we could not send today's alerts" become indistinguishable.
 */
export async function markEventsSuppressed(
  ids: readonly string[],
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(siAiVisibilityEvents)
    .set({
      deliveryStatus: "suppressed",
      suppressionReason: reason.slice(0, 300),
    })
    .where(inArray(siAiVisibilityEvents.id, [...ids]));
}

export async function markQueryChecked(id: string): Promise<void> {
  await db
    .update(siAiVisibilityQueries)
    .set({ lastCheckedAt: nowIso(), updatedAt: nowIso() })
    .where(eq(siAiVisibilityQueries.id, id));
}

export async function costTotals(month?: string): Promise<{
  estimatedCostMicros: number;
  actualCostMicros: number;
  snapshots: number;
}> {
  const target = month ?? nowIso().slice(0, 7);
  const rows = await db
    .select({
      estimated: sql<number>`coalesce(sum(${siAiVisibilitySnapshots.estimatedCostMicros}), 0)`,
      actual: sql<number>`coalesce(sum(${siAiVisibilitySnapshots.actualCostMicros}), 0)`,
      total: sql<number>`count(*)`,
    })
    .from(siAiVisibilitySnapshots)
    .where(sql`substr(${siAiVisibilitySnapshots.checkedAt}, 1, 7) = ${target}`);
  const row = rows[0];
  return {
    estimatedCostMicros: Number(row?.estimated ?? 0),
    actualCostMicros: Number(row?.actual ?? 0),
    snapshots: Number(row?.total ?? 0),
  };
}
