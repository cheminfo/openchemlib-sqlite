import { buildSSPrefilter } from '../utils/buildSSPrefilter.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from '../utils/prescreen.ts';

import { readFoldState } from './foldState.ts';
import { TAIL_TABLE } from './planeSchema.ts';

/**
 * Build the statement screening one source of unfolded entries.
 *
 * Exported so a test can assert the plan: the entries above the watermark must
 * be read through the entry index, or this screen would walk the whole index
 * and the plane path would cost what the column path does.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param source - `'tail'`, or the watermark the entries above it start from
 *   (null reads every entry, which only a database never folded would need).
 * @returns The SQL and the parameters to bind, in order.
 */
export function buildUnfoldedSql(
  params: Pick<
    PrescreenParams,
    'entriesTable' | 'pkColumn' | 'idCodeColumn' | 'mol'
  >,
  source: 'tail' | { after: number | null },
): { sql: string; params: unknown[] } {
  const { entriesTable, pkColumn, idCodeColumn, mol } = params;
  const prefilter = buildSSPrefilter(mol.getIndex());
  let from = `${TAIL_TABLE} s`;
  let range = '';
  const rangeParams: unknown[] = [];
  if (source !== 'tail') {
    if (source.after === null) {
      from = 'ocl_ss_index s';
    } else {
      from = 'ocl_ss_index s INDEXED BY idx_ocl_ss_entry';
      range = ' AND s.entry_id > ?';
      rangeParams.push(source.after);
    }
  }
  return {
    sql: `SELECT s.entry_id, s.mw, e.${idCodeColumn} AS id_code
            FROM ${from}
            JOIN ${entriesTable} e ON e.${pkColumn} = s.entry_id
           WHERE ${prefilter.sql}${range}`,
    params: [...prefilter.params, ...rangeParams],
  };
}

/**
 * Yield every entry no fold has reached whose fingerprint is a superset of the
 * query's: the tail first, then the entries above the watermark.
 *
 * An entry can be in both during a fold, and in the planes as well once a chunk
 * holding it is published before the watermark moves; `seen` is what makes each
 * one count once. It starts with the ids already yielded and gains every id
 * this yields.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param seen - Entry ids already yielded, extended with each new one.
 * @yields {PrescreenedCandidate} Each candidate, once.
 */
export function* prescreenUnfolded(
  params: PrescreenParams,
  state: PrescreenState,
  seen: Set<number>,
): Generator<PrescreenedCandidate> {
  const { db, timeoutMs, maxCandidates, onProgress } = params;
  const { foldedThrough } = readFoldState(db);
  const deadline = Date.now() + timeoutMs;
  for (const source of ['tail', { after: foldedThrough }] as const) {
    const query = buildUnfoldedSql(params, source);
    const statement = db.prepare(query.sql);
    // Streamed when the driver can, so a search stopping early does not read
    // every entry inserted since the last fold.
    const rows = (
      statement.iterate
        ? statement.iterate(...query.params)
        : statement.all(...query.params)
    ) as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const entryId = Number(row.entry_id);
      if (seen.has(entryId)) continue;
      if (state.screened >= maxCandidates) {
        state.partial = true;
        return;
      }
      seen.add(entryId);
      state.screened++;
      yield { entryId, idCode: row.id_code as string, mw: Number(row.mw) };
      if (state.screened % 500 === 0) {
        onProgress?.(state.screened, state.screened);
        if (Date.now() > deadline) {
          state.partial = true;
          state.timedOut = true;
          return;
        }
      }
    }
  }
}
