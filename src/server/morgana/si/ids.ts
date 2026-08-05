/**
 * Morgana Search Intelligence — id and timestamp helpers.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Shared by the store and the ledger store so the two cannot drift on id shape
 * or timestamp format — both are part of dedupe keys, where a mismatch would be
 * silent.
 */

/** Prefixed, URL-safe id. The prefix makes a stray id readable in a log. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
