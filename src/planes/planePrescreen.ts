import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase, SQLiteStatement } from '../types.ts';
import { packSSIndex } from '../utils/packSSIndex.ts';
import type {
  PrescreenState,
  PrescreenedCandidate,
} from '../utils/prescreen.ts';

import { intersectPlanes } from './planeIntersect.ts';
import { SLOTS_PER_CHUNK, bitsOfIndex, readBit } from './planeLayout.ts';
import { BITSTAT_TABLE, SEGMENT_TABLE, SLOT_TABLE } from './planeSchema.ts';

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
   * `fromIDCode` parse, which is ~625 µs. Turning it off drops two of the three
   * joins per candidate and leaves the real matcher to reject them.
   * @default true
   */
  exactFilter?: boolean;
  /**
   * Entries already yielded by another screen, skipped here before they are
   * counted, so an entry both folded and waiting in the tail counts once.
   * @default empty
   */
  exclude?: ReadonlySet<number>;
}

/**
 * The query's bits, rarest first, or null when the planes cannot screen it.
 *
 * Only bits the index kept a plane for are usable, and they are ordered by how
 * many entries set them so the intersection sheds candidates as fast as
 * possible. A query whose every bit is one of the common ones the fold dropped
 * gets no screen at all and belongs on the column path.
 * @param db - The database to read the bit statistics from.
 * @param index - The query fingerprint, as `Molecule.getIndex()` returns it.
 * @returns The usable bit positions, rarest first, or null.
 */
export function planeQueryBits(
  db: SQLiteDatabase,
  index: number[] | Uint32Array,
): number[] | null {
  const wanted = bitsOfIndex(index);
  if (wanted.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT bit, population FROM ${BITSTAT_TABLE}
        WHERE stored = 1 AND bit IN (${wanted.map(() => '?').join(',')})
        ORDER BY population ASC`,
    )
    .all(...wanted) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  return rows.map((row) => Number(row.bit));
}

/**
 * How many segments the plane index holds, and how many slots it covers.
 *
 * Every segment is internally ascending by molecular weight, so one segment
 * means slot order *is* mw order and the plane path can serve an ordered search
 * directly. With several, an ordered search needs them merged by mw — until
 * that exists, an ordered search over a multi-segment index stays on the column
 * path, while an unordered one is served whatever the segment count.
 * @param db - The database to read.
 * @returns The segment count and the number of slots in use.
 */
export function planeCoverage(db: SQLiteDatabase): {
  segments: number;
  slots: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS segments, COALESCE(SUM(slot_count), 0) AS slots
         FROM ${SEGMENT_TABLE}`,
    )
    .get() as Record<string, unknown> | undefined;
  return {
    segments: Number(row?.segments ?? 0),
    slots: Number(row?.slots ?? 0),
  };
}

/**
 * Yield every folded entry whose fingerprint is a superset of the query's.
 *
 * The planes screen; they do not decide. A fold drops the planes of bits most
 * molecules set, so the intersection is a superset of the true candidate set,
 * and every survivor is checked against its stored 512-bit fingerprint before
 * being yielded. That exact test is what lets the index be a few bytes per
 * molecule instead of 64 without ever returning a wrong candidate.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param bits - The query's usable bits, rarest first, from {@link planeQueryBits}.
 * @yields {PrescreenedCandidate} Each candidate, in slot order.
 */
export function* prescreenPlanes(
  params: PlanePrescreenParams,
  state: PrescreenState,
  bits: readonly number[],
): Generator<PrescreenedCandidate> {
  const {
    db,
    entriesTable,
    pkColumn,
    idCodeColumn,
    mol,
    maxCandidates,
    onProgress,
    timeoutMs,
    exactFilter = true,
    exclude,
  } = params;
  const query = packSSIndex(mol.getIndex());
  // Enumerated rather than counted: a fold starts on a chunk boundary, so an
  // index of three segments has gaps in its chunk numbering and a range derived
  // from the slot count would stop before the later segments.
  const chunks = planeChunks(db);

  // Resolved a batch of slots per statement, never one at a time. Measured at
  // 300 k entries, a slot-at-a-time lookup of 41 038 survivors cost 300 ms
  // against the 86 ms column scan it was meant to beat: the intersection was
  // never the problem, three joins per candidate were.
  const resolve = db.prepare(
    exactFilter
      ? `SELECT t.slot, s.entry_id, s.mw, e.${idCodeColumn} AS id_code,
                s.ss_index0, s.ss_index1, s.ss_index2, s.ss_index3,
                s.ss_index4, s.ss_index5, s.ss_index6, s.ss_index7
           FROM json_each(?) j
           JOIN ${SLOT_TABLE} t ON t.slot = j.value
           JOIN ocl_ss_index s ON s.entry_id = t.entry_id
           JOIN ${entriesTable} e ON e.${pkColumn} = t.entry_id
          ORDER BY t.slot`
      : `SELECT t.slot, t.entry_id, NULL AS mw, e.${idCodeColumn} AS id_code
           FROM json_each(?) j
           JOIN ${SLOT_TABLE} t ON t.slot = j.value
           JOIN ${entriesTable} e ON e.${pkColumn} = t.entry_id
          ORDER BY t.slot`,
  );
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
        exactFilter ? query : null,
        state,
        maxCandidates,
        exclude,
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
        exactFilter ? query : null,
        state,
        maxCandidates,
        exclude,
      );
      if (state.partial) return;
    }
  }
  onProgress?.(state.screened, state.screened);
}

/**
 * Turn a batch of surviving slots into candidates.
 *
 * Every row is checked against its stored 512-bit fingerprint first: the planes
 * of the bits most molecules set are not kept, so the intersection is a superset
 * of the true candidate set and this test is what makes the answer exact.
 * @param resolve - Statement joining a JSON array of slots to their entries.
 * @param slots - The surviving slots, ascending.
 * @param query - The query fingerprint packed into eight 64-bit values, or null
 *   to accept every survivor and let the real matcher reject the false ones.
 * @param state - Mutable counters updated as candidates are yielded.
 * @param maxCandidates - How many candidates the caller will take.
 * @param exclude - Entries another screen already yielded.
 * @yields {PrescreenedCandidate} Each candidate of the batch, in slot order.
 */
function* resolveBatch(
  resolve: SQLiteStatement,
  slots: readonly number[],
  query: bigint[] | null,
  state: PrescreenState,
  maxCandidates: number,
  exclude: ReadonlySet<number> | undefined,
): Generator<PrescreenedCandidate> {
  const rows = resolve.all(JSON.stringify(slots)) as Array<
    Record<string, unknown>
  >;
  for (const row of rows) {
    if (query !== null && !isSuperset(row, query)) continue;
    if (exclude?.has(Number(row.entry_id))) continue;
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
 * The chunks a search may read, ascending.
 *
 * Derived from the segments rather than from the planes themselves, and that is
 * what makes a fold safe to interrupt: a chunk whose planes are written but
 * whose segment has not been extended is not listed here, so it cannot answer.
 * Taken from `ocl_ss_plane` instead, a half-written chunk would be read as
 * complete and quietly return false negatives — a missing plane row legitimately
 * means "no entry here sets this bit".
 * @param db - The database to read.
 * @returns Every chunk number a published segment covers.
 */
export function planeChunks(db: SQLiteDatabase): number[] {
  const rows = db
    .prepare(
      `SELECT first_slot, slot_count FROM ${SEGMENT_TABLE}
        WHERE slot_count > 0 ORDER BY first_slot`,
    )
    .all() as Array<Record<string, unknown>>;
  const chunks = new Set<number>();
  for (const row of rows) {
    const first = Number(row.first_slot);
    const last = first + Number(row.slot_count) - 1;
    for (
      let chunk = Math.floor(first / SLOTS_PER_CHUNK);
      chunk <= Math.floor(last / SLOTS_PER_CHUNK);
      chunk++
    ) {
      chunks.add(chunk);
    }
  }
  return [...chunks].toSorted((a, b) => a - b);
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

/**
 * How many slots the plane intersection leaves, without resolving any of them.
 *
 * This is the router's input, and it is cheap: the intersection is the fast half
 * of the plane path, while turning slots back into entries costs a batched join
 * per candidate. A query the screen barely narrows is therefore better served by
 * the clustered column scan, which streams in molecular-weight order and can
 * stop early — and this says so before any of that work is done.
 *
 * It is an upper bound, because the planes of bits most molecules set are not
 * kept, so some survivors fail the exact 512-bit test afterwards.
 * @param db - The database to read.
 * @param bits - The query's usable bits, rarest first, from {@link planeQueryBits}.
 * @returns How many slots survived the intersection.
 */
export function planeSurvivorCount(
  db: SQLiteDatabase,
  bits: readonly number[],
): number {
  let total = 0;
  for (const survivors of intersectPlanes(db, bits, planeChunks(db))) {
    total += survivors.count;
  }
  return total;
}
