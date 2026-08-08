import { isEnabled, type Phase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — what WOULD be sent, without sending it.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P20).
 *
 * Alert routing is the one part of this subsystem that cannot be verified by
 * turning it on: switching alerts on to find out where they go is how a
 * misrouted impersonation warning ends up in a marketing channel. So the
 * decision — which channel, what payload, and why nothing is being delivered —
 * is made by a pure function that this surface exposes and the delivery path
 * would share.
 *
 * IT MAKES NO NETWORK CALL. Not "usually"; there is no fetch in this file and a
 * test asserts it, because a dry run that can talk to Slack is not a dry run.
 */

/** The three logical destinations. Never a URL — the engine holds none. */
export type LogicalChannel = "intel" | "brand_protection" | "security";

/**
 * The families of evidence a finding can rest on.
 *
 * `security` requires TWO of these independently, and that is the whole reason
 * the concept exists: one noisy signal should never be able to page anybody,
 * however high it scores itself.
 */
export type SignalFamily =
  | "ranking"
  | "backlink"
  | "content"
  | "domain_registration"
  | "certificate"
  | "traffic"
  | "reputation";

export interface AlertFinding {
  /** What produced it. */
  kind:
    | "ranking_change"
    | "competitor_move"
    | "backlink_change"
    | "campaign"
    | "reputation"
    | "suspicious_domain"
    | "impersonation"
    | "brand_confusion";
  title: string;
  summary: string;
  /** The engine's own risk verdict for the finding. */
  risk: "low" | "medium" | "high";
  /** Distinct evidence families. Duplicates are collapsed before counting. */
  signalFamilies: readonly SignalFamily[];
  /** Optional context. Sanitised before it appears in a payload. */
  subject?: string | null;
}

/**
 * Which channel does this finding belong to?
 *
 * NO FALLBACK BETWEEN CHANNELS, EVER. If a channel is unusable the alert is
 * suppressed, not rerouted: a brand-protection warning delivered to the SEO
 * channel is not a degraded success, it is a misfiled security signal, and the
 * person who needed it never learns it existed.
 */
export function routeFinding(finding: AlertFinding): LogicalChannel {
  const families = new Set(finding.signalFamilies);
  const protectionKind =
    finding.kind === "suspicious_domain" ||
    finding.kind === "impersonation" ||
    finding.kind === "brand_confusion";

  // High risk corroborated by two INDEPENDENT families is the only thing that
  // reaches the security channel. Both halves matter: high risk alone is one
  // detector's opinion of itself, and two families of low-risk noise is still
  // noise.
  if (finding.risk === "high" && families.size >= 2) return "security";
  if (protectionKind) return "brand_protection";
  return "intel";
}

/** Why nothing would be delivered. Null means it would be. */
type SuppressionReason =
  | "alerts_disabled"
  | "webhook_invalid_configuration"
  | "webhook_not_configured"
  | null;

/** Per-channel configuration state, as reported by whoever owns the webhooks. */
export type ChannelState =
  | "configured"
  | "webhook_invalid_configuration"
  | "webhook_not_configured"
  | "unknown";

/**
 * Strip anything a payload has no business carrying.
 *
 * Findings are built from provider data and from crawled pages, both of which
 * are untrusted text. Slack markup is escaped by the delivery layer in Morgana;
 * what this does is bound the length and remove control characters, so a dry
 * run cannot be used to render something enormous or invisible.
 */
function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[^\x20-\x7e -￿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

interface AlertDryRunResult {
  channel: LogicalChannel;
  wouldDeliver: boolean;
  suppressionReason: SuppressionReason;
  channelState: ChannelState;
  /** Exactly what would be handed to the delivery layer. Never a URL. */
  payload: {
    channel: LogicalChannel;
    title: string;
    summary: string;
    risk: AlertFinding["risk"];
    signalFamilies: SignalFamily[];
    subject: string | null;
  };
  /** Stated so a reader does not have to trust the name of the endpoint. */
  networkCallsMade: 0;
}

/**
 * Decide, render, and deliver nothing.
 *
 * `channelStates` is supplied by the caller because the engine genuinely does
 * not know it — Morgana owns the webhook secrets and their classification. An
 * absent entry is `unknown`, and an unknown channel suppresses: this function
 * will not assume a channel works because nobody told it otherwise.
 */
export function alertDryRun(
  config: Phase0Config,
  finding: AlertFinding,
  channelStates: Partial<Record<LogicalChannel, ChannelState>> = {},
): AlertDryRunResult {
  const channel = routeFinding(finding);
  const channelState = channelStates[channel] ?? "unknown";

  // The master switch is checked FIRST and reported as the reason, because a
  // configuration problem behind a closed master switch is not why nothing was
  // delivered, and naming the deeper cause would send someone to fix the wrong
  // thing.
  const alertsOn =
    isEnabled(config.SEARCH_INTELLIGENCE_AI_VISIBILITY_ALERTS_ENABLED) ||
    isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ALERTS_ENABLED);

  const suppressionReason: SuppressionReason = !alertsOn
    ? "alerts_disabled"
    : channelState === "webhook_invalid_configuration"
      ? "webhook_invalid_configuration"
      : channelState === "configured"
        ? null
        : "webhook_not_configured";

  return {
    channel,
    wouldDeliver: suppressionReason === null,
    suppressionReason,
    channelState,
    payload: {
      channel,
      title: sanitizeText(finding.title, 200),
      summary: sanitizeText(finding.summary, 600),
      risk: finding.risk,
      signalFamilies: [...new Set(finding.signalFamilies)],
      subject: finding.subject ? sanitizeText(finding.subject, 200) : null,
    },
    networkCallsMade: 0,
  };
}
