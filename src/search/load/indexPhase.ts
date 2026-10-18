import type { ReaderContext } from './readerContext.ts';
import { pull } from './readerContext.ts';

/** What the index phase reads. */
export interface IndexTask {
  /** Per atom count, its cells as (first row, end row) pairs of the row space. */
  segments: Float64Array[];
  /** Per atom count, receives its rows sorted by seq. */
  indexes: SharedArrayBuffer[];
  /** Per atom count, receives the seqs in that order (kept for the phases that merge with it). */
  seqArrays: SharedArrayBuffer[];
  counter: SharedArrayBuffer;
}

/**
 * Per atom count, its cells' rows (each ascending by seq, empty slots skipped) merged by seq: the
 * seq index (id → row), which the band order otherwise loses.
 * @param context - The reader.
 * @param task - The phase.
 * @returns The rows indexed.
 */
export function runIndex(context: ReaderContext, task: IndexTask): number {
  const { counter, segments, indexes, seqArrays } = task;
  let rows = 0;
  for (const t of pull(counter, segments.length)) {
    const out = new Int32Array(indexes[t] as SharedArrayBuffer);
    const seqs = new Uint32Array(seqArrays[t] as SharedArrayBuffer);
    const n = mergeCells(context, segments[t] as Float64Array, out, seqs);
    if (n !== out.length) {
      throw new Error(
        `atom count index: ${n} rows merged, ${out.length} planned`,
      );
    }
    rows += n;
  }
  return rows;
}

/** Per cell: its current row, its end, the block holding it (and that block's end), its seq. */
interface Cursors {
  at: Float64Array;
  end: Float64Array;
  blockEnd: Float64Array;
  block: Int32Array;
  key: Float64Array;
}

/**
 * The rows of one atom count's cells merged by seq with a heap.
 * @param context - The reader.
 * @param cells - The cells, as (first row, end row) pairs.
 * @param out - Receives the rows, in seq order.
 * @param seqs - Receives their seqs.
 * @returns The rows merged.
 */
function mergeCells(
  context: ReaderContext,
  cells: Float64Array,
  out: Int32Array,
  seqs: Uint32Array,
): number {
  const m = cells.length / 2;
  const cursors: Cursors = {
    at: new Float64Array(m),
    end: new Float64Array(m),
    blockEnd: new Float64Array(m),
    block: new Int32Array(m),
    key: new Float64Array(m),
  };
  const { at, end, blockEnd, key } = cursors;
  const heap = new Int32Array(m);
  let size = 0;
  for (let c = 0; c < m; c++) {
    at[c] = cells[2 * c] as number;
    end[c] = cells[2 * c + 1] as number;
    blockEnd[c] = -1;
    if (advance(context, cursors, c)) heap[size++] = c;
  }
  for (let i = (size >> 1) - 1; i >= 0; i--) siftDown(heap, size, key, i);
  let n = 0;
  while (size > 0) {
    const c = heap[0] as number;
    seqs[n] = key[c] as number;
    out[n++] = at[c] as number;
    at[c] = (at[c] as number) + 1;
    if (!advance(context, cursors, c)) heap[0] = heap[--size] as number;
    if (size > 0) siftDown(heap, size, key, 0);
  }
  return n;
}

/**
 * Moves a cell's cursor to its next non-empty row.
 * @param context - The reader.
 * @param cursors - The cells' cursors.
 * @param c - The cell.
 * @returns False when the cell is done.
 */
function advance(context: ReaderContext, cursors: Cursors, c: number): boolean {
  const { at, end, blockEnd, block, key } = cursors;
  for (
    ;
    (at[c] as number) < (end[c] as number);
    at[c] = (at[c] as number) + 1
  ) {
    const g = at[c] as number;
    if (g >= (blockEnd[c] as number)) {
      block[c] = context.blockOf(g);
      const found = context.block(block[c]);
      blockEnd[c] = found.start + found.capacity;
    }
    const b = block[c] as number;
    const seq = context.views(b).seq[g - context.block(b).start] as number;
    if (seq !== 0) {
      key[c] = seq;
      return true;
    }
  }
  return false;
}

function siftDown(
  heap: Int32Array,
  size: number,
  key: Float64Array,
  start: number,
): void {
  let i = start;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let low = i;
    if (
      l < size &&
      (key[heap[l] as number] as number) < (key[heap[low] as number] as number)
    ) {
      low = l;
    }
    if (
      r < size &&
      (key[heap[r] as number] as number) < (key[heap[low] as number] as number)
    ) {
      low = r;
    }
    if (low === i) return;
    const swap = heap[i] as number;
    heap[i] = heap[low] as number;
    heap[low] = swap;
    i = low;
  }
}
