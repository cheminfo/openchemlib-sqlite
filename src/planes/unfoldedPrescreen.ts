import { buildSSPrefilter } from '../utils/buildSSPrefilter.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from '../utils/prescreenTypes.ts';
import {
  installScanDeadline,
  isScanDeadline,
  scanDeadlineGuard,
} from '../utils/scanDeadline.ts';

/**
 * Build the statement screening the entries above the watermark.
 *
 * Exported so a test can assert the plan: the range must be sought on the
 * entry index, or this screen would walk the whole index and the plane path
 * would cost what the column path does.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param watermark - The planes hold every entry up to this id.
 * @param deadline - When the scan must stop, in ms since the epoch, or null to
 *   leave the guard out on a connection that lacks its function.
 * @returns The SQL and the parameters to bind, in order.
 */
export function buildUnfoldedSql(
  params: Pick<
    PrescreenParams,
    | 'entriesTable'
    | 'pkColumn'
    | 'idCodeColumn'
    | 'mol'
    | 'queryIndex'
    | 'columnBounds'
  >,
  watermark: number,
  deadline: number | null = null,
): { sql: string; params: unknown[] } {
  const {
    entriesTable,
    pkColumn,
    idCodeColumn,
    mol,
    queryIndex,
    columnBounds,
  } = params;
  const prefilter = buildSSPrefilter(queryIndex ?? mol.getIndex());
  const bounds = columnBounds ?? { conditions: [], values: [] };
  // The guard comes first, so the rows the prefilter rejects meet the clock too.
  const guard =
    deadline === null ? '' : `${scanDeadlineGuard('s.entry_id')} AND `;
  return {
    sql: `SELECT s.entry_id, s.mw, e.${idCodeColumn} AS id_code
            FROM ocl_ss_index s INDEXED BY idx_ocl_ss_entry
            JOIN ${entriesTable} e ON e.${pkColumn} = s.entry_id
           WHERE ${guard}s.entry_id > ? AND ${prefilter.sql}${bounds.conditions.map((condition) => ` AND ${condition}`).join('')}`,
    params: [
      ...(deadline === null ? [] : [deadline]),
      watermark,
      ...prefilter.params,
      ...bounds.values,
    ],
  };
}

/**
 * Yield every entry above the watermark whose fingerprint is a superset of the
 * query's: what no fold has reached, and what a write below the old watermark
 * has left untrusted. No entry is both here and in the planes' answer, which
 * stops at the watermark.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param watermark - The planes hold every entry up to this id.
 * @yields {PrescreenedCandidate} Each candidate, in entry id order.
 */
export function* prescreenUnfolded(
  params: PrescreenParams,
  state: PrescreenState,
  watermark: number,
): Generator<PrescreenedCandidate> {
  const { db, timeoutMs, maxCandidates, onProgress } = params;
  const deadline = Date.now() + timeoutMs;
  const query = buildUnfoldedSql(
    params,
    watermark,
    installScanDeadline(db) ? deadline : null,
  );
  const statement = db.prepare(query.sql);
  try {
    // Streamed when the driver can, so a search stopping early does not read
    // every entry inserted since the last fold.
    const rows = (
      statement.iterate
        ? statement.iterate(...query.params)
        : statement.all(...query.params)
    ) as Iterable<Record<string, unknown>>;
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
      if (state.screened % 500 === 0) {
        onProgress?.(state.screened, state.screened);
      }
      if (Date.now() > deadline) {
        state.partial = true;
        state.timedOut = true;
        return;
      }
    }
  } catch (error: unknown) {
    if (!isScanDeadline(error)) throw error;
    state.partial = true;
    state.timedOut = true;
  }
}
