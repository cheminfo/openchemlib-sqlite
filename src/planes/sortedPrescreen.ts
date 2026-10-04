import type {
  SQLiteDatabase,
  SQLiteStatement,
  ScanPosition,
} from '../types.ts';
import { buildSSPrefilter } from '../utils/buildSSPrefilter.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from '../utils/prescreenTypes.ts';
import { weightFloor } from '../utils/queryMwBound.ts';
import {
  ScanDeadlineError,
  installScanDeadline,
  isScanDeadline,
  scanDeadlineGuard,
} from '../utils/scanDeadline.ts';

import type { Key } from './keyMerge.ts';
import { compareKeys, lowerBound, mergeInOrder } from './keyMerge.ts';
import { RESOLVE_BATCH } from './planePrescreen.ts';
import { SEGMENT_TABLE, SLOT_TABLE } from './planeSchema.ts';

/** idCodes read per statement once the candidates are in order. */
const ID_CODE_BATCH = 256;

/** What the plane side of a switched scan reads. */
export interface SortedPlaneSource {
  /** The surviving slots, ascending, from the intersection made at the checkpoint. */
  slots: Uint32Array;
  /** The planes are trusted for entry ids up to this. */
  watermark: number;
  /** Where the column scan stopped: every candidate up to it was yielded. */
  position: ScanPosition;
}

/** The conditions every candidate past the position meets, on `s`. */
interface Range {
  sql: string;
  values: unknown[];
}

/**
 * Yield the rest of a bounded scan from the plane index, in the order the
 * column scan would have: `(mw, entry_id)`, after where it stopped.
 *
 * A fold reads the index in that order, so each segment of the plane index
 * holds its entries in it, and its survivors resolved in slot order come out
 * sorted. The segments' streams and the entries above the watermark are
 * merged, so candidates are produced lazily and in order: the caller goes on
 * stopping at `maxResults` exactly as on the column path, the answer is
 * identical, and only the survivors up to its last candidate are ever read.
 * Each is resolved with the exact 512-bit test, the weight bounds and the
 * position applied in SQL, and the entries table is read only for the idCodes
 * of the candidates handed out, a batch at a time.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param source - The survivors, the watermark and where the column scan stopped.
 * @yields {PrescreenedCandidate} Each candidate, in ascending `(mw, entry_id)`.
 */
export function* prescreenPlanesSorted(
  params: PrescreenParams,
  state: PrescreenState,
  source: SortedPlaneSource,
): Generator<PrescreenedCandidate> {
  const { db, timeoutMs, entriesTable, pkColumn, idCodeColumn } = params;
  const deadline = Date.now() + timeoutMs;
  state.switchedToPlanes = true;
  const range = rangeConditions(params, source.position);
  const read = db.prepare(
    `SELECT e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code
       FROM json_each(?) j
       JOIN ${entriesTable} e ON e.${pkColumn} = j.value`,
  );

  try {
    const streams = segmentStreams(db, source, range, deadline);
    streams.push(readUnfolded(db, source.watermark, range, deadline));
    const batch: Key[] = [];
    for (const key of mergeInOrder(streams)) {
      batch.push(key);
      if (batch.length < ID_CODE_BATCH) continue;
      yield* handOut(read, batch, params, state);
      batch.length = 0;
      if (state.partial) return;
      if (Date.now() > deadline) throw new ScanDeadlineError();
    }
    yield* handOut(read, batch, params, state);
  } catch (error: unknown) {
    if (!isScanDeadline(error)) throw error;
    state.partial = true;
    state.timedOut = true;
  }
}

/**
 * The conditions every candidate past the position meets, on `s`.
 * @param params - Prescreen parameters.
 * @param position - Where the column scan stopped.
 * @returns The SQL, each condition prefixed with ` AND `, and its parameters.
 */
function rangeConditions(
  params: PrescreenParams,
  position: ScanPosition,
): Range {
  const { mol, queryIndex, mwRange, columnBounds } = params;
  const prefilter = buildSSPrefilter(queryIndex ?? mol.getIndex());
  const lower = Math.max(
    weightFloor(params) ?? Number.NEGATIVE_INFINITY,
    mwRange?.min ?? Number.NEGATIVE_INFINITY,
  );
  let sql = ` AND ${prefilter.sql} AND (s.mw, s.entry_id) > (?, ?)`;
  const values: unknown[] = [
    ...prefilter.params,
    position.mw,
    position.entryId,
  ];
  if (lower > Number.NEGATIVE_INFINITY) {
    sql += ' AND s.mw >= ?';
    values.push(lower);
  }
  if (mwRange?.max !== undefined) {
    sql += ' AND s.mw <= ?';
    values.push(mwRange.max);
  }
  for (const condition of columnBounds?.conditions ?? []) {
    sql += ` AND ${condition}`;
  }
  values.push(...(columnBounds?.values ?? []));
  return { sql, values };
}

/**
 * One stream of candidates per segment of the plane index, each sorted.
 * @param db - The database to read.
 * @param source - The survivors and the watermark.
 * @param range - The conditions on each candidate.
 * @param deadline - When to give up, in ms since the epoch.
 * @returns The streams.
 */
function segmentStreams(
  db: SQLiteDatabase,
  source: SortedPlaneSource,
  range: Range,
  deadline: number,
): Array<Iterator<Key>> {
  const resolve = db.prepare(
    `SELECT s.mw, s.entry_id
       FROM json_each(?) j
       JOIN ${SLOT_TABLE} t ON t.slot = j.value
       JOIN ocl_ss_index s ON s.entry_id = t.entry_id
      WHERE t.entry_id <= ?${range.sql}
      ORDER BY t.slot`,
  );
  const segments = db
    .prepare(
      `SELECT first_slot, slot_count FROM ${SEGMENT_TABLE}
        WHERE slot_count > 0 ORDER BY first_slot`,
    )
    .all() as Array<Record<string, unknown>>;
  const { slots, watermark } = source;
  return segments.map((segment) => {
    const first = Number(segment.first_slot);
    const from = lowerBound(slots, first);
    const to = lowerBound(slots, first + Number(segment.slot_count));
    return resolveRun(slots.subarray(from, to), (batch) =>
      resolve.all(batch, watermark, ...range.values),
    );
  });

  function* resolveRun(
    run: Uint32Array,
    query: (batch: string) => unknown[],
  ): Generator<Key> {
    for (let from = 0; from < run.length; from += RESOLVE_BATCH) {
      if (Date.now() > deadline) throw new ScanDeadlineError();
      const batch = JSON.stringify(
        Array.from(run.subarray(from, from + RESOLVE_BATCH)),
      );
      for (const row of query(batch) as Array<Record<string, unknown>>) {
        yield { mw: Number(row.mw), entryId: Number(row.entry_id) };
      }
    }
  }
}

/**
 * The entries above the watermark past the position, sorted.
 * @param db - The database to read.
 * @param watermark - The planes hold every entry up to this id.
 * @param range - The conditions on each candidate.
 * @param deadline - When to give up, in ms since the epoch.
 * @returns A stream of them.
 */
function readUnfolded(
  db: SQLiteDatabase,
  watermark: number,
  range: Range,
  deadline: number,
): Iterator<Key> {
  const guarded = installScanDeadline(db);
  const rows = db
    .prepare(
      `SELECT s.mw, s.entry_id
         FROM ocl_ss_index s INDEXED BY idx_ocl_ss_entry
        WHERE ${guarded ? `${scanDeadlineGuard('s.entry_id')} AND ` : ''}s.entry_id > ?${range.sql}`,
    )
    .all(...(guarded ? [deadline] : []), watermark, ...range.values) as Array<
    Record<string, unknown>
  >;
  const keys = rows.map((row) => ({
    mw: Number(row.mw),
    entryId: Number(row.entry_id),
  }));
  return keys.toSorted(compareKeys).values();
}

/**
 * Hand a batch of candidates out, with the idCodes read for all of them in
 * one statement.
 * @param read - Statement reading idCodes for a JSON array of entry ids.
 * @param batch - The candidates, in order.
 * @param params - Prescreen parameters.
 * @param state - Mutable counters updated as candidates are yielded.
 * @yields {PrescreenedCandidate} Each candidate the entries table holds.
 */
function* handOut(
  read: SQLiteStatement,
  batch: readonly Key[],
  params: PrescreenParams,
  state: PrescreenState,
): Generator<PrescreenedCandidate> {
  if (batch.length === 0) return;
  const idCodes = new Map<number, string>();
  for (const row of read.all(
    JSON.stringify(batch.map((key) => key.entryId)),
  ) as Array<Record<string, unknown>>) {
    idCodes.set(Number(row.entry_id), row.id_code as string);
  }
  for (const key of batch) {
    // An entry the entries table no longer holds — or never exposed, when it
    // is a view — is not a candidate on the column path either.
    const idCode = idCodes.get(key.entryId);
    if (idCode === undefined) continue;
    if (state.screened >= params.maxCandidates) {
      state.partial = true;
      return;
    }
    state.screened++;
    yield { entryId: key.entryId, idCode, mw: key.mw };
  }
  params.onProgress?.(state.screened, state.screened);
}
