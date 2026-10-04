import { buildSSPrefilter } from './buildSSPrefilter.ts';
import type { PrescreenParams } from './prescreenTypes.ts';
import { scanDeadlineGuard } from './scanDeadline.ts';

/** What {@link buildPrescreenSql} needs to know about a scan. */
export type PrescreenSqlParams = Pick<
  PrescreenParams,
  | 'entriesTable'
  | 'pkColumn'
  | 'idCodeColumn'
  | 'mol'
  | 'queryIndex'
  | 'candidates'
  | 'mwFloor'
  | 'mwRange'
  | 'after'
  | 'deadline'
> & {
  /**
   * The key under which the guard records the row it stopped at, so a scan
   * stopped at a checkpoint can resume from there.
   * @default undefined — the guard records nothing
   */
  guardKey?: number;
};

/**
 * Build the prescreen query and its bound parameters.
 *
 * Exported so a test can assert the plan SQLite picks for it: the whole design
 * rests on `ocl_ss_index` being the driving table, which is what makes the scan
 * follow the index's physical (mw, entry_id) order and stream. The `drive`
 * strategy is the one exception, and it sorts what it reads instead.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @returns The SQL and the parameters to bind, in order.
 */
export function buildPrescreenSql(params: PrescreenSqlParams): {
  sql: string;
  params: unknown[];
} {
  const {
    entriesTable,
    pkColumn,
    idCodeColumn,
    mol,
    queryIndex,
    candidates,
    mwFloor,
    mwRange,
    after,
    deadline,
    guardKey,
  } = params;
  const strategy = candidates ? (candidates.strategy ?? 'membership') : null;

  // `drive` reads the candidates first and each one's fingerprint through the
  // entry_id index; DISTINCT because a subquery over a link table may name an
  // entry twice, which the other strategies — set tests — never notice.
  const from =
    candidates && strategy === 'drive'
      ? `FROM (SELECT DISTINCT entry_id FROM (${candidates.sql})) c
     CROSS JOIN ocl_ss_index s ON s.entry_id = c.entry_id`
      : `FROM ocl_ss_index s`;
  const select = `SELECT s.entry_id, s.mw, e.${idCodeColumn} AS id_code
     ${from}
     JOIN ${entriesTable} e ON e.${pkColumn} = s.entry_id`;

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (deadline != null) {
    // First, so that a row every later condition rejects still meets the
    // clock. The drive strategy reads its candidates before any row of the
    // index, so there is no position of the index to record there.
    const records = guardKey !== undefined && strategy !== 'drive';
    conditions.push(
      strategy === 'drive'
        ? scanDeadlineGuard('c.entry_id')
        : scanDeadlineGuard('s.entry_id', records ? 's.mw' : undefined),
    );
    values.push(deadline, ...(records ? [guardKey] : []));
  }
  // An empty fragment is contained in every molecule: skip the prefilter (and,
  // in the caller, the verification) and just stream the lightest entries.
  if (mol.getAllAtoms() > 0) {
    const prefilter = buildSSPrefilter(queryIndex ?? mol.getIndex());
    conditions.push(prefilter.sql);
    values.push(...prefilter.params);
  }
  // The index is clustered by weight, so these are the predicates SQLite seeks
  // rather than tests. A superstructure cannot be lighter than its fragment,
  // which starts the scan past every entry too light to match; the caller's
  // range narrows the same seek from both ends.
  const lower = Math.max(
    mwFloor != null && mwFloor > 0 ? mwFloor : Number.NEGATIVE_INFINITY,
    mwRange?.min ?? Number.NEGATIVE_INFINITY,
  );
  if (mwRange?.max !== undefined) {
    conditions.push('s.mw <= ?');
    values.push(mwRange.max);
  }
  // Only one lower bound is written: SQLite seeks on one of two, and testing
  // the other row by row would read again everything a resumed scan has
  // already passed. Whichever is higher implies the other.
  if (after !== undefined && after.mw >= lower) {
    // A row value is sought on the clustered key like a bound on its first
    // column, so a resumed scan reads nothing it already read.
    conditions.push('(s.mw, s.entry_id) > (?, ?)');
    values.push(after.mw, after.entryId);
  } else if (lower > Number.NEGATIVE_INFINITY) {
    conditions.push('s.mw >= ?');
    values.push(lower);
  }
  if (candidates && strategy === 'membership') {
    // The unary `+` is what keeps this streamable. Without it SQLite drives the
    // scan off the subquery — it is the smaller side and has no statistics —
    // which abandons the index's physical (mw, entry_id) order, forcing a temp
    // b-tree to sort it back and materialising every candidate before yielding
    // the first row. `+` marks the term unusable by an index, so ocl_ss_index
    // stays the driving table: it is scanned in mw order, the subquery is
    // materialised once into a list (plus a bloom filter) and merely probed.
    conditions.push(`+s.entry_id IN (${candidates.sql})`);
  } else if (candidates && strategy === 'probe') {
    // Correlated, so nothing is materialised: SQLite flattens the subquery and
    // seeks it on the entry id, once per entry the prefilter let through.
    conditions.push(
      `EXISTS (SELECT 1 FROM (${candidates.sql}) c WHERE c.entry_id = s.entry_id)`,
    );
  }

  // The ORDER BY is a safety net for the streaming strategies, not a sort: the
  // clustered scan already satisfies it, so SQLite optimises it away. Should it
  // ever pick a different plan, the result stays correct (just slower) rather
  // than silently coming back in the wrong order. For `drive` it is the sort.
  let order = '';
  if (strategy === 'drive') order = ' ORDER BY s.mw, s.entry_id';
  else if (strategy !== null) order = ' ORDER BY s.mw';
  const where =
    conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  return {
    sql: `${select}${where}${order}`,
    // The candidates subquery binds named parameters, so it does not compete
    // for the anonymous `?` slots and its object may come first whatever the
    // order the placeholders appear in.
    params: [...(candidates?.params ? [candidates.params] : []), ...values],
  };
}
