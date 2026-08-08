import { badRequest, envelope, isRecord, json, num, readJson } from "./http";
import * as keywordVolumes from "./keyword-volume-service";
import * as p2service from "./p2-service";
import { expireStaleReservations, globalSpend } from "./budget-authority";
import { holdingReservations, resolveReservation } from "./budget-reservations";
import { clearProviderState } from "./provider-circuit";
import { checkProviderHealth } from "./provider-health";
import {
  alertDryRun,
  type AlertFinding,
  type ChannelState,
  type LogicalChannel,
} from "./alert-dry-run";
import * as p2Store from "./p2-store";
import { capabilityMatrix, evaluateReleaseGate } from "./rollout-readiness";
import { dryRunSchedule, proposedPolicy } from "./scheduler-dry-run";
import { readinessFacts } from "./readiness-facts";
import * as keywordVolumeStore from "./keyword-volume-store";
import * as entityStore from "./store";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — the keyword-volume surface.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Split from `p2-router.ts` for size, and the split falls in a sensible place:
 * one route spends money to measure volumes, the other reads what was measured.
 */
export async function dispatchKeywordVolume(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, env, providerStatus } = ctx;
  const method = request.method;

  // Collect the search volumes the whole of phase 2 weights by. A paid provider
  // call, so it answers to the same pre-flight as buying a ranking.
  if (route === "keyword-volume-refresh" && method === "POST") {
    const body = await readJson(request);
    const ids = Array.isArray(body.tracked_keyword_ids)
      ? body.tracked_keyword_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    const result = await keywordVolumes.refreshKeywordVolumes(config, env, {
      providerStatus,
      limit: num(body.limit) ?? 50,
      trackedKeywordIds: ids,
    });

    // A measured volume changes the gap and the opportunity score for that
    // keyword, so the derived rows are refreshed here rather than left stale
    // until the next rank tick. Free — it reads observations already stored.
    const recomputed =
      result.withVolume > 0
        ? await p2service.recomputeAfterVolumeChange(
            config,
            result.recomputeKeywordIds,
          )
        : { keywords: 0, eventsDetected: 0 };

    return json(
      envelope(config, { ...result, recomputed }, { providerStatus }),
    );
  }

  // Recompute the gap and the opportunity scores from data already stored.
  //
  // Free, and separate from the collection that pays: a volume measured earlier,
  // a CTR model change or a correction all invalidate the derived rows without
  // anybody needing to buy anything. Without this the only way to refresh them
  // would be to spend money again, which is a bad reason to make a paid call.
  if (route === "gap-recompute" && method === "POST") {
    const keywords = await keywordVolumeStore.trackedKeywordIds();
    const result = await p2service.recomputeAfterVolumeChange(config, keywords);
    return json(envelope(config, result, { providerStatus }));
  }

  // The whole subsystem's budget, in one place. Free: it reads persisted rows
  // and reconciles reservations whose process died — which are NOT released,
  // because we cannot know whether the provider charged for them.
  if (route === "budget" && method === "GET") {
    const reconciled = await expireStaleReservations();
    const spend = await globalSpend(config);
    return json(envelope(config, { ...spend, reconciled }, { providerStatus }));
  }

  // Which reservations are holding capacity, and what it would take to settle
  // them. Free and read-only. `GET budget` reports `reconciliation_pending` as
  // a bare count, so this is the difference between knowing that something is
  // stuck and being able to go and unstick it.
  if (route === "budget/reservations" && method === "GET") {
    const reservations = await holdingReservations();
    return json(
      envelope(
        config,
        {
          reservations: reservations.map(reservationView),
          holding_micros: reservations.reduce(
            (sum, row) => sum + row.estimatedMaxCostMicros,
            0,
          ),
          // Stated rather than implied: a reconciliation needs all three, and
          // the resolver refuses without them.
          resolution_requires: [
            "exact provider-verified cost in micro-USD",
            "evidence the cost was verified against",
            "actor",
          ],
        },
        { providerStatus },
      ),
    );
  }

  // SETTLE ONE RESERVATION AGAINST EVIDENCE. The only transition out of
  // `reconciliation_pending`, and the only hard, never-waivable release
  // blocker. `resolveReservation` has existed since migration 0050 with exactly
  // the right contract — integer micro-USD, non-empty evidence, non-empty actor,
  // typed refusals, its own columns — and nothing could reach it, which made a
  // blocker that could only be cleared by a human unclearable by anyone.
  //
  // A stated ZERO is accepted, because "the provider never billed this" is a
  // real finding. It still needs evidence: proved and deduced are different
  // things, and this endpoint only takes the first.
  {
    const match = /^budget\/reservations\/([A-Za-z0-9_-]{1,64})\/resolve$/.exec(
      route,
    );
    if (match?.[1] && method === "POST") {
      const body = await readJson(request);
      const result = await resolveReservation({
        reservationId: match[1],
        // Deliberately NOT coerced. A float, a numeric string or a null is a
        // caller who does not have an exact figure, and the refusal is the
        // correct answer to that.
        verifiedCostMicros:
          typeof body.exact_cost_micros === "number"
            ? body.exact_cost_micros
            : Number.NaN,
        evidence: typeof body.evidence === "string" ? body.evidence : "",
        actor: typeof body.actor === "string" ? body.actor : "",
      });
      return json(
        envelope(config, result, { providerStatus }),
        result.resolved ? 200 : 422,
      );
    }
  }

  // IS THE PROVIDER ACCOUNT USABLE — asked for nothing.
  //
  // Two DataForSEO endpoints the provider documents as non-billable: the
  // appendix user-data read and the AI Optimization model catalogue. Verifying
  // a credential with a paid call is how a check turns into a charge, so this
  // route cannot make one: nothing here reserves capacity and nothing reaches a
  // billable endpoint.
  if (route === "provider/health" && method === "GET") {
    const health = await checkProviderHealth(config, {
      credentialPresent: providerStatus !== "not_configured",
      checkAi: url.searchParams.get("ai") !== "false",
    });
    return json(envelope(config, health, { providerStatus }));
  }

  // THE ONLY EXIT FROM A LATCHED BREAKER, and it is never automatic. A `40201`
  // means the account is suspended; no cooldown, no scheduler and no successful
  // call elsewhere may lift it. Someone has to say who they are and why.
  if (route === "provider/reset" && method === "POST") {
    const body = await readJson(request);
    const result = await clearProviderState({
      actor: typeof body.actor === "string" ? body.actor : "",
      reason: typeof body.reason === "string" ? body.reason : "",
      credentialGeneration:
        config.SEARCH_INTELLIGENCE_PROVIDER_ACCOUNT_GENERATION,
    });
    return json(
      envelope(config, result, { providerStatus }),
      result.cleared ? 200 : 422,
    );
  }

  // WHERE WOULD THIS GO, AND WHY IS NOTHING BEING SENT?
  //
  // Routing is the one thing that cannot be verified by switching alerts on —
  // finding out where an impersonation warning lands by delivering it is not a
  // test. So the decision is exposed without the delivery. No network call is
  // made from this path, and a test asserts it.
  if (route === "alerts/dry-run" && method === "POST") {
    const body = await readJson(request);
    const finding = parseFinding(body);
    if (!finding) {
      return badRequest(
        "INVALID_FINDING",
        "a finding needs a known kind, a title and a risk of low|medium|high",
      );
    }
    return json(
      envelope(config, alertDryRun(config, finding, channelStatesFrom(body)), {
        providerStatus,
      }),
    );
  }

  // Release readiness: what is built, what a provider has actually served, what
  // has enough data to say anything, and what a human still has to decide.
  // Read-only and free — it creates no job, takes no reservation and calls no
  // provider, which is what makes it safe to ask at any time.
  if (route === "readiness" && method === "GET") {
    const spend = await globalSpend(config);
    const trackedKeywords = await p2Store.listTrackedKeywords();
    const activeEntities = await entityStore.listEntities();
    const facts = await readinessFacts(config, spend, trackedKeywords.length);
    const matrix = capabilityMatrix(config, facts);
    const gate = evaluateReleaseGate(matrix, facts);
    const policy = proposedPolicy({
      criticalKeywords: trackedKeywords.filter((k) => k.priority === "critical")
        .length,
      highKeywords: trackedKeywords.filter((k) => k.priority === "high").length,
      normalKeywords: trackedKeywords.filter((k) => k.priority === "normal").length,
      lowKeywords: trackedKeywords.filter((k) => k.priority === "low").length,
      entities: activeEntities.length,
    });
    const forecast = dryRunSchedule(
      {
        criticalKeywords: trackedKeywords.filter((k) => k.priority === "critical").length,
        highKeywords: trackedKeywords.filter((k) => k.priority === "high").length,
        normalKeywords: trackedKeywords.filter((k) => k.priority === "normal").length,
        lowKeywords: trackedKeywords.filter((k) => k.priority === "low").length,
        entities: activeEntities.length,
        policy,
      },
      {
        dailyMicros: spend.dailyCapMicros,
        monthlyMicros: spend.monthlyCapMicros,
      },
    );
    return json(
      envelope(
        config,
        {
          capabilities: matrix,
          gate,
          // The proposed cadence, priced, with every entry still disabled.
          scheduler_dry_run: forecast,
          budget: {
            daily_actual_micros: spend.dailyActualMicros,
            monthly_actual_micros: spend.monthlyActualMicros,
            open_reservations_micros: spend.openReservationsMicros,
            daily_cap_micros: spend.dailyCapMicros,
            monthly_cap_micros: spend.monthlyCapMicros,
            over_daily_cap: spend.overDailyCap,
            per_collector: spend.perCollector,
            reconciliation_pending: spend.reconciliationPending,
            unexpected_spend_detected: spend.unexpectedSpendDetected,
          },
          // Logical channel and state only — never a URL, valid or not.
          webhooks: facts.webhooksInvalid.map((channel) => ({
            channel,
            configured: false,
            state: "webhook_invalid_configuration",
            delivery: "suppressed",
          })),
        },
        { providerStatus },
      ),
    );
  }

  // What was measured, when, and whether the provider actually answered.
  if (route === "keyword-volumes" && method === "GET") {
    const rows = await keywordVolumeStore.latestVolumeSnapshots(100);
    return json(
      envelope(
        config,
        {
          snapshots: rows.map((row) => ({
            tracked_keyword_id: row.trackedKeywordId,
            keyword: row.keyword,
            location_code: row.locationCode,
            language_code: row.languageCode,
            search_engine: row.searchEngine,
            search_volume: row.searchVolume,
            competition: row.competition,
            competition_level: row.competitionLevel,
            cost_per_click_micros: row.costPerClickMicros,
            keyword_difficulty: row.keywordDifficulty,
            search_intent: row.searchIntent,
            provider: row.provider,
            source: row.source,
            collected_at: row.collectedAt,
            collection_window: row.collectionWindow,
            snapshot_status: row.snapshotStatus,
            snapshot_status_reason: row.snapshotStatusReason,
          })),
        },
        { providerStatus },
      ),
    );
  }

  return null;
}

/**
 * What a reservation looks like from outside.
 *
 * The reservation rows carry everything needed to audit a charge, and some of
 * it is not a status surface's business. Ids are abbreviated because a reader
 * needs to TELL TWO ROWS APART and correlate them with an invoice, not to
 * reconstruct them; the full id is what the resolve endpoint takes, and whoever
 * is settling one already has it from the ledger.
 *
 * Never present, at any verbosity: an Authorization header, a credential, a
 * provider password, a full request payload or a full receipt.
 */
function abbreviate(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function reservationView(
  row: Awaited<ReturnType<typeof holdingReservations>>[number],
) {
  return {
    reservation_id: abbreviate(row.id),
    job_id: abbreviate(row.jobId),
    operation_id: row.operationId,
    collector: row.collector,
    endpoint: row.operationType,
    // The keyword or domain the operation ran against.
    subject: row.subject,
    subject_scope: row.subjectScope,
    created_at: row.createdAt,
    estimated_max_cost_micros: row.estimatedMaxCostMicros,
    // What the PROVIDER reported, which for a pending row is nothing at all.
    // Null here is the entire reason the row is stuck, so it is reported as
    // null rather than smoothed to a zero.
    actual_cost_micros: row.actualCostMicros ?? null,
    status: row.status,
    cost_status: row.costStatus,
    evidence_required: true,
  };
}

/**
 * Channel states are supplied by the caller — the engine owns no webhooks.
 *
 * Narrowed with declared predicates rather than assertions: everything here
 * arrives from a request body, and an assertion would be this router promising
 * a shape a stranger sent it.
 */
const CHANNEL_STATES: readonly ChannelState[] = [
  "configured",
  "webhook_invalid_configuration",
  "webhook_not_configured",
  "unknown",
];

const CHANNELS: readonly LogicalChannel[] = [
  "intel",
  "brand_protection",
  "security",
];

function asChannelState(value: unknown): ChannelState | null {
  return CHANNEL_STATES.find((state) => state === value) ?? null;
}

function channelStatesFrom(
  body: Record<string, unknown>,
): Partial<Record<LogicalChannel, ChannelState>> {
  const raw = body.channel_states;
  if (!isRecord(raw)) return {};
  const out: Partial<Record<LogicalChannel, ChannelState>> = {};
  for (const channel of CHANNELS) {
    const state = asChannelState(raw[channel]);
    if (state) out[channel] = state;
  }
  return out;
}

/**
 * Parse a finding, refusing anything outside the vocabulary.
 *
 * A dry run whose input is whatever the caller sent would answer questions
 * about findings that cannot exist, and its answers would be quoted. Unknown
 * kinds and risks are rejected rather than defaulted — defaulting a risk to
 * `low` would make an unroutable finding look deliberately unimportant.
 */
const FINDING_KINDS: readonly AlertFinding["kind"][] = [
  "ranking_change",
  "competitor_move",
  "backlink_change",
  "campaign",
  "reputation",
  "suspicious_domain",
  "impersonation",
  "brand_confusion",
];

type SignalFamily = AlertFinding["signalFamilies"][number];

const SIGNAL_FAMILIES: readonly SignalFamily[] = [
  "ranking",
  "backlink",
  "content",
  "domain_registration",
  "certificate",
  "traffic",
  "reputation",
];

function asFindingKind(value: unknown): AlertFinding["kind"] | null {
  return FINDING_KINDS.find((kind) => kind === value) ?? null;
}

function asSignalFamily(value: unknown): SignalFamily | null {
  return SIGNAL_FAMILIES.find((family) => family === value) ?? null;
}

function parseFinding(body: Record<string, unknown>): AlertFinding | null {
  const kind = asFindingKind(body.kind);
  const risk = body.risk;
  const title = body.title;
  if (
    !kind ||
    typeof title !== "string" ||
    title.trim() === "" ||
    (risk !== "low" && risk !== "medium" && risk !== "high")
  ) {
    return null;
  }
  const rawFamilies = Array.isArray(body.signal_families)
    ? body.signal_families
    : [];
  const signalFamilies: SignalFamily[] = [];
  for (const entry of rawFamilies) {
    const family = asSignalFamily(entry);
    if (family) signalFamilies.push(family);
  }
  return {
    kind,
    title,
    summary: typeof body.summary === "string" ? body.summary : "",
    risk,
    signalFamilies,
    subject: typeof body.subject === "string" ? body.subject : null,
  };
}
