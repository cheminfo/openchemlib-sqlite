import type { MwRange, SearchCandidates } from '../types.ts';

/** The pieces that restrict a query over `entriesTable e JOIN ocl_ss_index s`. */
export interface EntryRestriction {
  /** A JOIN onto the entries table `e`, or ''. */
  join: string;
  /** Conditions to AND into the WHERE clause, each prefixed with ` AND `, or ''. */
  where: string;
  /** The candidates' named parameters, which bind before every anonymous one. */
  named: Array<Record<string, unknown>>;
  /** The values of the anonymous parameters `where` holds, in order. */
  values: number[];
}

/**
 * The SQL restricting an exact, hash or similarity query to a caller's
 * candidates subquery and weight range.
 *
 * An exact or hash query is driven by one equality and reads a handful of
 * rows, so the subquery is always tested per row there, as a correlated
 * `EXISTS`: that never materialises it and never repeats an entry the subquery
 * names twice, whatever strategy was asked for. A similarity scan reads every
 * entry, so it follows the strategy: `probe` tests per row, the others join the
 * subquery, which SQLite materialises once.
 *
 * The weight range is a test on `s.mw` in these queries — none of them walks
 * the clustered key.
 * @param pkColumn - The entries table's primary key.
 * @param perRow - Whether the query reads few enough rows to test each one.
 * @param candidates - The caller's subquery, if any.
 * @param mwRange - The caller's weight range, if any.
 * @returns The pieces to splice into the query.
 */
export function restrictEntries(
  pkColumn: string,
  perRow: boolean,
  candidates?: SearchCandidates,
  mwRange?: MwRange,
): EntryRestriction {
  const correlated =
    candidates !== undefined && (perRow || candidates.strategy === 'probe');
  const where: string[] = [];
  const values: number[] = [];
  if (candidates && correlated) {
    where.push(
      `EXISTS (SELECT 1 FROM (${candidates.sql}) c WHERE c.entry_id = e.${pkColumn})`,
    );
  }
  if (mwRange?.min !== undefined) {
    where.push('s.mw >= ?');
    values.push(mwRange.min);
  }
  if (mwRange?.max !== undefined) {
    where.push('s.mw <= ?');
    values.push(mwRange.max);
  }
  return {
    join:
      candidates && !correlated
        ? `JOIN (${candidates.sql}) c ON c.entry_id = e.${pkColumn}`
        : '',
    where: where.map((condition) => ` AND ${condition}`).join(''),
    named: candidates?.params ? [candidates.params] : [],
    values,
  };
}

/**
 * Identify a restriction inside a search-cache key, so a restricted search
 * never returns another subset's — or the unrestricted — cached results.
 * @param candidates - The subquery restricting the search, if any.
 * @param mwRange - The weight range restricting it, if any.
 * @returns A key fragment identifying the subquery, its values and the range.
 */
export function restrictionKey(
  candidates: SearchCandidates | undefined,
  mwRange: MwRange | undefined,
): string {
  const range = `${mwRange?.min ?? ''}..${mwRange?.max ?? ''}`;
  if (!candidates) return range;
  return `${candidates.strategy ?? 'membership'}|${candidates.sql}|${JSON.stringify(candidates.params ?? {})}|${range}`;
}
