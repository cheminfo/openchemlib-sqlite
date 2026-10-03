import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase, SQLiteStatement } from '../types.ts';
import { packSSIndex } from '../utils/packSSIndex.ts';
import type {
  PrescreenState,
  PrescreenedCandidate,
} from '../utils/prescreen.ts';

import { planeChunks } from './planeCoverage.ts';
import { intersectPlanes } from './planeIntersect.ts';
import { SLOTS_PER_CHUNK, readBit } from './planeLayout.ts';
import { SLOT_TABLE } from './planeSchema.ts';

type OCLMolecule = InstanceType<(typeof OpenChemLib)['Molecule']>;

/**
 * Surviving slots resolved per statement.
 *
 * Big enough that the three joins are amortised, small enough that a search
 * stopping at a handful of results does not pull a chunk's worth of rows.
 */
const RESOLVE_BATCH = 1024;

export interface PlanePrescreenParams {
  db: SQLiteDatabase;
  entriesTable: string;
  /** Primary-key column of the entries table. */
  pkColumn: string;
  /** idCode column of the entries table. */
  idCodeColumn: string;
  /** Fragment flag must already be set to true before passing. */
  mol: OCLMolecule;
  timeoutMs: number;
  maxCandidates: number;
  onProgress?: (processed: number, total: number) => void;
  /**
   * Whether a survivor is checked against its stored 512-bit fingerprint.
   *
   * The fold keeps no plane for the bits most molecules set, so a survivor can
   * in principle be missing one of those and the check is what makes the answer
   * exact. Measured on a 2 M-entry library it rejected nothing at all — a
   * fragment's rare bits already imply its common ones — but the rate depends on
   * the corpus, and a false positive that reaches verification costs a
   * `fromIDCode` parse, which is ~625 µs. Turning it off reads no fingerprint
   * and leaves the real matcher to reject them; the entry is still looked up,
   * so a removed one is never yielded either way.
   * @default true
   */
  exactFilter?: boolean;
}

/**
 * Yield every folded entry at or below the watermark whose fingerprint is a
 * superset of the query's.
 *
 * The planes screen; they do not decide. A fold drops the planes of bits most
 * molecules set, so the intersection is a superset of the true candidate set,
 * and every survivor is checked against its stored 512-bit fingerprint before
 * being yielded. That exact test is what lets the index be a few bytes per
 * molecule instead of 64 without ever returning a wrong candidate.
 *
 * A slot standing for an entry above the watermark is skipped: its bits may be
 * those of a fingerprint since replaced, and the entry is screened from
 * `ocl_ss_index` instead. So is a slot whose entry has left the index.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param bits - The query's usable bits, rarest first, from `planeQueryBits()`.
 * @param watermark - The planes are trusted for entry ids up to this.
 * @yields {PrescreenedCandidate} Each candidate, in slot order.
 */
export function* prescreenPlanes(
  params: PlanePrescreenParams,
  state: PrescreenState,
  bits: readonly number[],
  watermark: number,
): Generator<PrescreenedCandidate> {
  const {
    db,
    mol,
    maxCandidates,
    onProgress,
    timeoutMs,
    exactFilter = true,
  } = params;
  const query = exactFilter ? packSSIndex(mol.getIndex()) : null;
  // Enumerated rather than counted: a fold starts on a chunk boundary, so an
  // index of three segments has gaps in its chunk numbering and a range derived
  // from the slot count would stop before the later segments.
  const chunks = planeChunks(db);
  const resolve = db.prepare(buildResolveSql(params, exactFilter));
  resolve.setReadBigInts?.(true);

  const deadline = Date.now() + timeoutMs;
  for (const survivors of intersectPlanes(db, bits, chunks)) {
    const base = survivors.chunk * SLOTS_PER_CHUNK;
    let batch: number[] = [];
    for (let offset = 0; offset < survivors.length * 8; offset++) {
      if (!readBit(survivors.bits, offset)) continue;
      batch.push(base + offset);
      if (batch.length < RESOLVE_BATCH) continue;
      yield* resolveBatch(
        resolve,
        batch,
        watermark,
        query,
        state,
        maxCandidates,
      );
      batch = [];
      if (state.partial) return;
      onProgress?.(state.screened, state.screened);
      if (Date.now() > deadline) {
        state.partial = true;
        state.timedOut = true;
        return;
      }
    }
    if (batch.length > 0) {
      yield* resolveBatch(
        resolve,
        batch,
        watermark,
        query,
        state,
        maxCandidates,
      );
      if (state.partial) return;
    }
  }
  onProgress?.(state.screened, state.screened);
}

/**
 * The statement turning a JSON array of slots into candidates.
 *
 * Resolved a batch of slots per statement, never one at a time. Measured at
 * 300 k entries, a slot-at-a-time lookup of 41 038 survivors cost 300 ms
 * against the 86 ms column scan it was meant to beat: the intersection was
 * never the problem, three joins per candidate were.
 * @param params - The entries table and its columns.
 * @param exactFilter - Whether to read each entry's fingerprint.
 * @returns SQL taking the slots, as JSON, and the watermark.
 */
function buildResolveSql(
  params: Pick<
    PlanePrescreenParams,
    'entriesTable' | 'pkColumn' | 'idCodeColumn'
  >,
  exactFilter: boolean,
): string {
  const { entriesTable, pkColumn, idCodeColumn } = params;
  const words = exactFilter
    ? ', s.ss_index0, s.ss_index1, s.ss_index2, s.ss_index3, s.ss_index4, s.ss_index5, s.ss_index6, s.ss_index7'
    : '';
  return `SELECT t.slot, s.entry_id, s.mw, e.${idCodeColumn} AS id_code${words}
            FROM json_each(?) j
            JOIN ${SLOT_TABLE} t ON t.slot = j.value
            JOIN ocl_ss_index s ON s.entry_id = t.entry_id
            JOIN ${entriesTable} e ON e.${pkColumn} = t.entry_id
           WHERE t.entry_id <= ?
           ORDER BY t.slot`;
}

/**
 * Turn a batch of surviving slots into candidates.
 *
 * Every row is checked against its stored 512-bit fingerprint first: the planes
 * of the bits most molecules set are not kept, so the intersection is a superset
 * of the true candidate set and this test is what makes the answer exact.
 * @param resolve - Statement joining a JSON array of slots to their entries.
 * @param slots - The surviving slots, ascending.
 * @param watermark - The planes are trusted for entry ids up to this.
 * @param query - The query fingerprint packed into eight 64-bit values, or null
 *   to accept every survivor and let the real matcher reject the false ones.
 * @param state - Mutable counters updated as candidates are yielded.
 * @param maxCandidates - How many candidates the caller will take.
 * @yields {PrescreenedCandidate} Each candidate of the batch, in slot order.
 */
function* resolveBatch(
  resolve: SQLiteStatement,
  slots: readonly number[],
  watermark: number,
  query: bigint[] | null,
  state: PrescreenState,
  maxCandidates: number,
): Generator<PrescreenedCandidate> {
  const rows = resolve.all(JSON.stringify(slots), watermark) as Array<
    Record<string, unknown>
  >;
  for (const row of rows) {
    if (query !== null && !isSuperset(row, query)) continue;
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
}

/**
 * Whether a stored fingerprint holds every bit the query sets.
 * @param row - A row carrying ss_index0..7 as BigInt.
 * @param query - The query fingerprint, packed into eight 64-bit values.
 * @returns True when the row is a superset of the query.
 */
function isSuperset(row: Record<string, unknown>, query: bigint[]): boolean {
  for (let word = 0; word < 8; word++) {
    const wanted = query[word] ?? 0n;
    if (wanted === 0n) continue;
    const stored = (row[`ss_index${word}`] as bigint | undefined) ?? 0n;
    if ((stored & wanted) !== wanted) return false;
  }
  return true;
}
