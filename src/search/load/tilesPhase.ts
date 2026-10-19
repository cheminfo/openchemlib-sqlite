import {
  BAND_SPAN,
  BITS_AT,
  FRAGFP_PLANES,
  FUNCTION_PLANES_AT,
  N_AT,
  SEQ_AT,
  SLOTS,
  TILE_SPAN,
  tileKey,
} from '../../chemistry/tile.ts';
import {
  recordWords,
  scatterFunctionPlanes,
} from '../../chemistry/tileRecord.ts';
import { widenZones } from '../zones.ts';

import { RUN } from './layoutBlocks.ts';
import type { ReaderContext } from './readerContext.ts';
import { pull } from './readerContext.ts';

/**
 * The cells of atom counts, two seeks each: (atoms, band, first tile, tiles) quadruples.
 * @param context - The reader.
 * @param atomCounts - The atom counts.
 * @param counter - The shared task counter.
 * @returns The quadruples.
 */
export function runCells(
  context: ReaderContext,
  atomCounts: Float64Array,
  counter: SharedArrayBuffer,
): Float64Array {
  const first = context.db.prepare(
    'SELECT id FROM ocl_tile WHERE id >= ? AND id < ? ORDER BY id LIMIT 1',
  );
  const last = context.db.prepare(
    'SELECT max(id) AS id FROM ocl_tile WHERE id >= ? AND id < ?',
  );
  const out: number[] = [];
  for (const t of pull(counter, atomCounts.length)) {
    const atoms = atomCounts[t] as number;
    const end = tileKey(atoms + 1, 0, 0);
    for (let probe = tileKey(atoms, 0, 0); ;) {
      const row = first.get(probe, end) as { id: number } | undefined;
      if (row === undefined) break;
      const { id } = row;
      const cell = Math.floor(id / TILE_SPAN);
      const band = cell - atoms * BAND_SPAN;
      const next = tileKey(atoms, band + 1, 0);
      const firstTile = id - cell * TILE_SPAN;
      const lastTile =
        (last.get(id, next) as { id: number }).id - cell * TILE_SPAN;
      out.push(atoms, band, firstTile, lastTile - firstTile + 1);
      probe = next;
    }
  }
  return Float64Array.from(out);
}

/** What the tiles phase reads. */
export interface TilesTask {
  runs: Float64Array;
  chunks: Int32Array;
  cellOfRun: Int32Array;
  /** Per cell, the first tile holding a slot above the watermark (left to the tail). */
  tailFrom: SharedArrayBuffer;
  /** Per run, the rows it took. */
  rowsOfRun: SharedArrayBuffer;
  counter: SharedArrayBuffer;
}

/**
 * Copies tiles into the planes, a chunk of consecutive cells of one block read as one key range:
 * each tile goes to one word (plane p of the tile to plane p; the function planes it stores are
 * scattered, the others stay zero in the fresh block), its seqs and its slots' FragFp and screen
 * bit counts to the row columns, their ranges to the zone maps. Slots above the watermark are
 * masked, left to the tail; a tile written after the plan is skipped (its slots are above the
 * watermark too).
 * @param context - The reader.
 * @param task - The phase.
 * @returns Rows, tiles, masked slots and skipped tiles.
 */
export function runTiles(
  context: ReaderContext,
  task: TilesTask,
): { rows: number; tiles: number; masked: number; skipped: number } {
  const { runs, chunks, cellOfRun, counter, rowsOfRun } = task;
  const tailFrom = new Int32Array(task.tailFrom);
  const taken = new Float64Array(rowsOfRun);
  const { watermark } = context.data;
  const read = context.db.prepare(
    'SELECT id, data FROM ocl_tile WHERE id >= ? AND id < ? ORDER BY id',
  );
  read.setReturnArrays(true);
  const totals = { rows: 0, tiles: 0, masked: 0, skipped: 0 };
  const fragFpCounts = new Uint16Array(SLOTS);
  const screen = new Uint16Array(SLOTS);
  const slices = new Int32Array(10);
  for (const t of pull(counter, chunks.length / 2)) {
    const r1 = chunks[2 * t + 1] as number;
    let r = chunks[2 * t] as number;
    const atoms = runs[RUN * r] as number;
    const b = runs[RUN * r + 4] as number;
    const view = context.views(b);
    let band = runs[RUN * r + 1] as number;
    let expected = runs[RUN * r + 2] as number;
    let tile1 = runs[RUN * r + 3] as number;
    let w = runs[RUN * r + 5] as number;
    let expectedKey = tileKey(atoms, band, expected);
    const endKey = tileKey(
      atoms,
      runs[RUN * (r1 - 1) + 1] as number,
      runs[RUN * (r1 - 1) + 3] as number,
    );
    let runRows = 0;
    for (const [id, blob] of read.iterate(expectedKey, endKey) as Iterable<
      [number, Uint8Array]
    >) {
      if (id !== expectedKey) {
        if (id < expectedKey) {
          totals.skipped++;
          continue;
        }
        throw new Error(
          `cell (${atoms}, ${band}): tile ${expected} is missing`,
        );
      }
      const words = recordWords(blob);
      const seqs = new Uint32Array(
        words.buffer,
        words.byteOffset + SEQ_AT,
        SLOTS,
      );
      fragFpCounts.set(
        new Uint16Array(words.buffer, words.byteOffset + BITS_AT, SLOTS),
      );
      const used = words[N_AT / 4] as number;
      screenCounts(words, screen, slices);
      let take = 0;
      let mask = 0;
      const row0 = w * SLOTS;
      for (let i = 0; i < used; i++) {
        const seq = seqs[i] as number;
        if (seq > watermark) break;
        take++;
        // A removed molecule's slot stays used, with seq 0 and no bits.
        if (seq === 0) continue;
        mask |= 1 << i;
        view.seq[row0 + i] = seq;
        const fragFp = fragFpCounts[i] as number;
        const screenCount = screen[i] as number;
        view.fragFpBits[row0 + i] = fragFp;
        view.screenBits[row0 + i] = screenCount;
        widenZones(view.zones, w, fragFp, screenCount);
      }
      if (take < used) {
        totals.masked += used - take;
        const cell = cellOfRun[r] as number;
        for (
          let seen = Atomics.load(tailFrom, cell);
          expected < seen;
          seen = Atomics.load(tailFrom, cell)
        ) {
          if (
            Atomics.compareExchange(tailFrom, cell, seen, expected) === seen
          ) {
            break;
          }
        }
      }
      for (let p = 0; p < FUNCTION_PLANES_AT; p++) {
        view.planes[p * view.W + w] = (words[p] as number) & mask;
      }
      scatterFunctionPlanes(words, view.planes, view.W, w, mask);
      totals.rows += popcount(mask);
      totals.tiles++;
      runRows += popcount(mask);
      w++;
      expected++;
      if (expected < tile1) {
        expectedKey++;
        continue;
      }
      taken[r] = runRows;
      runRows = 0;
      r++;
      if (r === r1) break;
      if (runs[RUN * r + 5] !== w || runs[RUN * r + 4] !== b) {
        throw new Error(`chunk ${t}: run ${r} does not follow`);
      }
      band = runs[RUN * r + 1] as number;
      expected = runs[RUN * r + 2] as number;
      tile1 = runs[RUN * r + 3] as number;
      expectedKey = tileKey(atoms, band, expected);
    }
    if (r !== r1) {
      throw new Error(
        `cell (${atoms}, ${band}): tiles up to ${expected} read, ${tile1} planned`,
      );
    }
  }
  return totals;
}

/**
 * Each slot's screen bit count (planes 512-1023), with 10 bit-sliced counters.
 * @param words - The tile record's words, its 1,024 FragFp and screen planes first.
 * @param counts - Its slots' screen bit counts, written.
 * @param s - The counters, 10 words, reused from tile to tile.
 */
function screenCounts(
  words: Int32Array,
  counts: Uint16Array,
  s: Int32Array,
): void {
  s.fill(0);
  for (let p = FRAGFP_PLANES; p < FUNCTION_PLANES_AT; p++) {
    let carry = words[p] as number;
    for (let b = 0; b < 10 && carry !== 0; b++) {
      const v = s[b] as number;
      s[b] = v ^ carry;
      carry &= v;
    }
  }
  for (let lane = 0; lane < SLOTS; lane++) {
    let screen = 0;
    for (let b = 9; b >= 0; b--) {
      screen = (screen << 1) | (((s[b] as number) >>> lane) & 1);
    }
    counts[lane] = screen;
  }
}

function popcount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
