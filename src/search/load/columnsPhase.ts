import { SEQ_SPAN } from '../../chemistry/key.ts';
import { writeColumns } from '../blocks.ts';
import type { KeyHistogram } from '../histogram.ts';
import { binOf } from '../histogram.ts';

import type { ReaderContext } from './readerContext.ts';
import { pull } from './readerContext.ts';

/** What the columns phase reads. */
export interface ColumnsTask {
  /** (segment, first position, end position) per piece of a seq index. */
  tasks: Float64Array;
  indexes: SharedArrayBuffer[];
  seqArrays: SharedArrayBuffer[];
  atomCounts: number[];
  /** Receives the rows the columns SQL returns. */
  alive: SharedArrayBuffer;
  counter: SharedArrayBuffer;
}

/**
 * The application's columns of every row: the columns SQL over the id range of a piece of an atom
 * count's seq index, merged with it in id order. A row the SQL does not return, or returns with no
 * key, is dead: it is never answered.
 * @param context - The reader.
 * @param task - The phase.
 * @returns Rows, dead rows, and the least and largest key.
 */
export function runColumns(
  context: ReaderContext,
  task: ColumnsTask,
): { rows: number; dead: number; low: number; high: number } {
  const { layout, spec } = context.data;
  const statement = context.db.prepare(spec.columnsSql);
  statement.setReturnArrays(true);
  const alive = new Int32Array(task.alive);
  const out = { rows: 0, dead: 0, low: Infinity, high: -Infinity };
  let b = 0;
  for (const t of pull(task.counter, task.tasks.length / 3)) {
    const s = task.tasks[3 * t] as number;
    const i0 = task.tasks[3 * t + 1] as number;
    const i1 = task.tasks[3 * t + 2] as number;
    const index = new Int32Array(task.indexes[s] as SharedArrayBuffer);
    const seqs = new Uint32Array(task.seqArrays[s] as SharedArrayBuffer);
    const base = (task.atomCounts[s] as number) * SEQ_SPAN;
    const rows = statement.all({
      from: base + (seqs[i0] as number),
      to: base + (seqs[i1 - 1] as number),
    }) as unknown as unknown[][];
    let p = 0;
    for (let i = i0; i < i1; i++) {
      const g = index[i] as number;
      const block = context.block(b);
      if (!(g >= block.start && g < block.start + block.capacity)) {
        b = context.blockOf(g);
      }
      const view = context.views(b);
      const r = g - context.block(b).start;
      const id = base + (seqs[i] as number);
      while (p < rows.length && Number((rows[p] as unknown[])[0]) < id) p++;
      const values =
        p < rows.length && Number((rows[p] as unknown[])[0]) === id
          ? (rows[p++] as unknown[])
          : null;
      writeColumns(view, layout, r, values);
      out.rows++;
      const key = view.key[r] as number;
      if (Number.isNaN(key)) {
        out.dead++;
        continue;
      }
      Atomics.or(alive, g >>> 5, 1 << (g & 31));
      if (key < out.low) out.low = key;
      if (key > out.high) out.high = key;
    }
  }
  return out;
}

/** What the zones phase reads. */
export interface ZonesTask {
  /** Per cell, its first and end row. */
  cells: Float64Array;
  /** Receives per cell its least key, largest key and rows. */
  zones: SharedArrayBuffer;
  histogram: KeyHistogram;
  alive: SharedArrayBuffer;
  counter: SharedArrayBuffer;
}

/**
 * Each cell's zone (the least and largest key of its alive rows) and row count, and every alive
 * row's key into the histogram.
 * @param context - The reader.
 * @param task - The phase.
 * @returns The rows counted.
 */
export function runZones(context: ReaderContext, task: ZonesTask): number {
  const out = new Float64Array(task.zones);
  const counts = new Uint32Array(task.histogram.counts);
  const alive = new Int32Array(task.alive);
  let rows = 0;
  for (const t of pull(task.counter, task.cells.length / 2)) {
    let low = Infinity;
    let high = -Infinity;
    let count = 0;
    const end = task.cells[2 * t + 1] as number;
    for (let g = task.cells[2 * t] as number; g < end;) {
      const b = context.blockOf(g);
      const block = context.block(b);
      const { seq, key } = context.views(b);
      const stop = Math.min(end, block.start + block.capacity);
      for (let r = g - block.start; g < stop; g++, r++) {
        if (seq[r] === 0) continue;
        count++;
        if ((((alive[g >>> 5] as number) >>> (g & 31)) & 1) === 0) continue;
        const value = key[r] as number;
        if (value < low) low = value;
        if (value > high) high = value;
        Atomics.add(counts, binOf(task.histogram, value), 1);
      }
    }
    out[3 * t] = low;
    out[3 * t + 1] = high;
    out[3 * t + 2] = count;
    rows += count;
  }
  return rows;
}
