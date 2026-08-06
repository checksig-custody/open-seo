import { describe, expect, it } from "vitest";
import { chunkForD1, rowsPerStatement } from "./d1-chunk";

/**
 * Morgana Search Intelligence — bulk-insert chunking for D1.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Regression cover for the defect the first real crawl of checksig.com found:
 * the frontier insert chunked by ROW count (50) against an 11-column table, so
 * the seed batch bound 550 parameters and D1 refused the statement with
 * `too many SQL variables`. Every case here is the arithmetic that must hold
 * for a bulk insert to survive D1, expressed against the real column widths of
 * the phase-5 tables.
 */

/** The phase-5 tables that are written more than one row at a time. */
const BULK_TABLES = [
  { table: "si_site_audit_frontier", columns: 11 },
  { table: "si_site_audit_links", columns: 9 },
  { table: "si_site_audit_issues", columns: 19 },
  { table: "si_site_audit_issue_events", columns: 12 },
  { table: "si_ai_visibility_citations", columns: 12 },
] as const;

describe("d1 bulk-insert chunking", () => {
  it("never lets a statement exceed D1's 100 bound parameters", () => {
    for (const { table, columns } of BULK_TABLES) {
      const rows = rowsPerStatement(columns);
      expect(
        rows * columns,
        `${table} binds too many parameters`,
      ).toBeLessThanOrEqual(100);
      expect(rows, `${table} would write nothing`).toBeGreaterThanOrEqual(1);
    }
  });

  it("would have rejected the chunk size that failed in production", () => {
    // The original code: 50 rows of an 11-column table.
    expect(50 * 11).toBeGreaterThan(100);
    // What the helper picks instead.
    expect(rowsPerStatement(11)).toBe(9);
    expect(rowsPerStatement(11) * 11).toBeLessThanOrEqual(100);
  });

  it("splits a real seed batch into statements that D1 accepts", () => {
    // The exact shape of the failing crawl: 10 frontier rows in one call.
    const seed = Array.from({ length: 10 }, (_, i) => ({
      url: `/page-${String(i)}`,
    }));
    const batches = chunkForD1(seed, 11);
    expect(batches.length).toBe(2);
    for (const batch of batches) {
      expect(batch.length * 11).toBeLessThanOrEqual(100);
    }
    // Nothing is dropped and order is preserved — a frontier that silently lost
    // rows would produce a "complete" crawl that never visited them.
    expect(batches.flat()).toEqual(seed);
  });

  it("keeps every row when the input divides evenly and when it does not", () => {
    for (const count of [0, 1, 8, 9, 10, 97, 200]) {
      const rows = Array.from({ length: count }, (_, i) => i);
      expect(chunkForD1(rows, 12).flat()).toEqual(rows);
    }
  });

  it("still emits one row per statement for a table wider than the budget", () => {
    // si_site_audit_runs is 33 columns and si_site_audit_pages is 30; both are
    // written one row at a time, but the helper must not return 0 if either
    // ever becomes a bulk insert.
    expect(rowsPerStatement(30)).toBe(3);
    expect(rowsPerStatement(120)).toBe(1);
    expect(rowsPerStatement(0)).toBe(1);
  });
});
