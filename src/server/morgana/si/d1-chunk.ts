/**
 * Morgana Search Intelligence — bulk-insert chunking for D1.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * D1 binds at most 100 parameters per statement. A multi-row INSERT binds
 * `rows × columns` of them, so **the chunk size is a property of the row's
 * width, not a number you pick**. Chunking by row count is correct only until
 * somebody adds a column, and the failure mode is not a slow query — it is
 * `D1_ERROR: too many SQL variables`, at runtime, on the first insert large
 * enough to cross the line.
 *
 * That is exactly how this was found: the frontier insert chunked 50 rows of an
 * 11-column table (550 parameters) and the very first real crawl failed on its
 * seed batch. Deriving the chunk from the column count is the version that
 * cannot drift.
 */

/** D1's bound-parameter ceiling per statement. */
const D1_MAX_BOUND_PARAMS = 100;

/**
 * Largest number of rows that fits in one statement, given the row's width.
 *
 * Always at least 1: a row wider than the whole budget still has to be written,
 * and letting D1 reject it is better than silently writing nothing.
 */
export function rowsPerStatement(columnsPerRow: number): number {
  if (columnsPerRow <= 0) return 1;
  return Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsPerRow));
}

/** Split `rows` into statement-sized batches for a table of the given width. */
export function chunkForD1<T>(
  rows: readonly T[],
  columnsPerRow: number,
): T[][] {
  const size = rowsPerStatement(columnsPerRow);
  const batches: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    batches.push(rows.slice(offset, offset + size));
  }
  return batches;
}
