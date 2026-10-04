import { buildSSPrefilter } from './buildSSPrefilter.ts';
import type { PrefilterPlan } from './prefilterPlan.ts';
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
  /**
   * Which fingerprint words to test in which order, and where the guard goes.
   * @default the query's non-zero words, most bits first, the guard first
   */
  plan?: PrefilterPlan;
};

/** Conditions on `s` bounding the rows a scan reads, and their values. */
export interface SeekRange {
  /** The conditions, joined with AND, or an empty string. */
  sql: string;
  /** Their parameters, in order. */
  values: unknown[];
}

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
    deadline,
    guardKey,
    plan,
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
  const addGuard = () => {
    if (deadline == null) return;
    const records = guardKey !== undefined && strategy !== 'drive';
    conditions.push(
      strategy === 'drive'
        ? scanDeadlineGuard('c.entry_id')
        : scanDeadlineGuard(
            's.entry_id',
            records ? 's.mw' : undefined,
            plan?.guardMask,
          ),
    );
    values.push(deadline, ...(records ? [guardKey] : []));
  };
  // An empty fragment is contained in every molecule: skip the prefilter (and,
  // in the caller, the verification) and just stream the lightest entries.
  const terms =
    mol.getAllAtoms() > 0
      ? buildSSPrefilter(queryIndex ?? mol.getIndex(), plan?.words).terms
      : [];
  // The guard goes before every word, so that a row they all reject still
  // meets the clock — or after the first, when a plan measured that word to
  // let through enough rows for the clock to be read often all the same. The
  // drive strategy reads its candidates before any row of the index, so there
  // is no position of the index to record there.
  const guardAfter =
    strategy === 'drive' ? 0 : Math.min(plan?.guardAfter ?? 0, terms.length);
  for (const [index, term] of terms.entries()) {
    if (index === guardAfter) addGuard();
    conditions.push(term.sql);
    values.push(...term.params);
  }
  if (guardAfter >= terms.length) addGuard();
  const range = seekRange(params);
  if (range.sql !== '') {
    conditions.push(range.sql);
    values.push(...range.values);
  }
  if (candidates && strategy === 'membership') {
    // The unary `+` is what keeps this streamable. Without it SQLite drives the
    // scan off the subquery — it is the smaller side and has no statistics —
    // which abandons the index's physical (mw, entry_id) order, forcing a temp
    // b-tree to sort it back and materialising every candidate before yielding
    // the first row. `+` marks the term unusable by an index, so ocl_ss_index
    // stays the driving table: it is scanned in mw order, the subquery is
    // materialised once into a list (plus a bloom filter) and merely probed.
    //
    // Listing happens inside one step, before the scan's first row, so the
    // scan's own guard never runs while it does. A guard on the rows listed
    // makes it stop on time all the same, as long as the subquery keeps
    // producing them; one that reads many rows to produce few cannot be
    // stopped before it ends.
    if (deadline == null) {
      conditions.push(`+s.entry_id IN (${candidates.sql})`);
    } else {
      conditions.push(
        `+s.entry_id IN (SELECT entry_id FROM (${candidates.sql}) WHERE ${scanDeadlineGuard('entry_id')})`,
      );
      values.push(deadline);
    }
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

/**
 * The conditions bounding the rows a scan reads, which SQLite seeks on the
 * clustered key rather than tests: the weight range, the weight floor and the
 * position to resume after.
 *
 * Only one lower bound is written: SQLite seeks on one of two, and testing the
 * other row by row would read again everything a resumed scan has already
 * passed. Whichever is higher implies the other.
 * @param params - The scan.
 * @returns The conditions on `s`, and their values.
 */
export function seekRange(
  params: Pick<PrescreenParams, 'mwFloor' | 'mwRange' | 'after'>,
): SeekRange {
  const { mwFloor, mwRange, after } = params;
  const conditions: string[] = [];
  const values: unknown[] = [];
  // A superstructure cannot be lighter than its fragment, which starts the
  // scan past every entry too light to match; the caller's range narrows the
  // same seek from both ends.
  const lower = Math.max(
    mwFloor != null && mwFloor > 0 ? mwFloor : Number.NEGATIVE_INFINITY,
    mwRange?.min ?? Number.NEGATIVE_INFINITY,
  );
  if (mwRange?.max !== undefined) {
    conditions.push('s.mw <= ?');
    values.push(mwRange.max);
  }
  if (after !== undefined && after.mw >= lower) {
    // A row value is sought on the clustered key like a bound on its first
    // column, so a resumed scan reads nothing it already read.
    conditions.push('(s.mw, s.entry_id) > (?, ?)');
    values.push(after.mw, after.entryId);
  } else if (lower > Number.NEGATIVE_INFINITY) {
    conditions.push('s.mw >= ?');
    values.push(lower);
  }
  return { sql: conditions.join(' AND '), values };
}
