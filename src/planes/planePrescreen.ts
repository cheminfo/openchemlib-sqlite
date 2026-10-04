import { buildSSPrefilter } from '../utils/buildSSPrefilter.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from '../utils/prescreenTypes.ts';

import { planeChunks } from './planeCoverage.ts';
import { SLOT_TABLE } from './planeSchema.ts';
import { collectSurvivors } from './planeSurvivors.ts';

/**
 * Surviving slots resolved per statement.
 *
 * Big enough that the joins are amortised, small enough that a search stopping
 * at a handful of results does not pull a chunk's worth of rows.
 */
export const RESOLVE_BATCH = 1024;

export type PlanePrescreenParams = Pick<
  PrescreenParams,
  | 'db'
  | 'entriesTable'
  | 'pkColumn'
  | 'idCodeColumn'
  | 'mol'
  | 'queryIndex'
  | 'columnBounds'
  | 'timeoutMs'
  | 'maxCandidates'
  | 'onProgress'
> & {
  /**
   * Whether a survivor is checked against its stored 512-bit fingerprint.
   *
   * The fold keeps no plane for the bits most molecules set, and an
   * intersection stops reading planes once they no longer pay, so a survivor
   * can lack some of the query's bits and the check is what makes the answer
   * exact. It runs in the resolving statement, before the entries table is
   * read, so a false survivor costs three seeks in the index and nothing
   * more. Turning it off leaves the real matcher to reject them.
   * @default true
   */
  exactFilter?: boolean;
};

/**
 * Yield every folded entry at or below the watermark whose fingerprint is a
 * superset of the query's, in slot order.
 *
 * The planes screen; they do not decide. The intersection is a superset of the
 * true candidate set, and every survivor is checked against its stored 512-bit
 * fingerprint before being yielded. That exact test is what lets the index be
 * a few bytes per molecule instead of 64 without ever returning a wrong
 * candidate.
 *
 * A slot standing for an entry above the watermark is skipped: its bits may be
 * those of a fingerprint since replaced, and the entry is screened from
 * `ocl_ss_index` instead. So is a slot whose entry has left the index.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param bits - The query's usable bits, rarest first, from `planeQueryBits()`.
 * @param watermark - The planes are trusted for entry ids up to this.
 * @param slots - The surviving slots, when the router already collected them.
 * @yields {PrescreenedCandidate} Each candidate, in slot order.
 */
export function* prescreenPlanes(
  params: PlanePrescreenParams,
  state: PrescreenState,
  bits: readonly number[],
  watermark: number,
  slots?: Uint32Array,
): Generator<PrescreenedCandidate> {
  const {
    db,
    mol,
    queryIndex,
    columnBounds,
    maxCandidates,
    onProgress,
    timeoutMs,
    exactFilter = true,
  } = params;
  const deadline = Date.now() + timeoutMs;
  const survivors = slots ?? collectSurvivors(db, bits, planeChunks(db)).slots;
  const prefilter = exactFilter
    ? buildSSPrefilter(queryIndex ?? mol.getIndex())
    : null;
  const bounds = columnBounds ?? { conditions: [], values: [] };
  const resolve = db.prepare(
    buildResolveSql(params, [
      ...(prefilter === null ? [] : [prefilter.sql]),
      ...bounds.conditions,
    ]),
  );

  for (let from = 0; from < survivors.length; from += RESOLVE_BATCH) {
    const batch = survivors.subarray(from, from + RESOLVE_BATCH);
    const rows = resolve.all(
      JSON.stringify(Array.from(batch)),
      watermark,
      ...(prefilter?.params ?? []),
      ...bounds.values,
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (state.screened >= maxCandidates) {
        state.partial = true;
        return;
      }
      state.screened++;
      yield {
        entryId: Number(row.entry_id),
        idCode: row.id_code as string,
        mw: Number(row.mw),
      };
    }
    onProgress?.(state.screened, state.screened);
    if (Date.now() > deadline) {
      state.partial = true;
      state.timedOut = true;
      return;
    }
  }
}

/**
 * The statement turning a JSON array of slots into candidates.
 *
 * Resolved a batch of slots per statement, never one at a time. Measured at
 * 300 k entries, a slot-at-a-time lookup of 41 038 survivors cost 300 ms
 * against the 86 ms column scan it was meant to beat: the intersection was
 * never the problem, the joins per candidate were.
 *
 * The entries table is joined on the index's own entry id, so it can only be
 * read after the index row — and the exact test on it — have been.
 * @param params - The entries table and its columns.
 * @param conditions - The exact test on the fingerprint and the bounds on
 *   carried columns, each on `s`.
 * @returns SQL taking the slots as JSON, the watermark, then the conditions'
 *   parameters.
 */
function buildResolveSql(
  params: Pick<
    PlanePrescreenParams,
    'entriesTable' | 'pkColumn' | 'idCodeColumn'
  >,
  conditions: string[],
): string {
  const { entriesTable, pkColumn, idCodeColumn } = params;
  return `SELECT s.entry_id, s.mw, e.${idCodeColumn} AS id_code
            FROM json_each(?) j
            JOIN ${SLOT_TABLE} t ON t.slot = j.value
            JOIN ocl_ss_index s ON s.entry_id = t.entry_id
            JOIN ${entriesTable} e ON e.${pkColumn} = s.entry_id
           WHERE t.entry_id <= ?${conditions.map((condition) => ` AND ${condition}`).join('')}
           ORDER BY t.slot`;
}
