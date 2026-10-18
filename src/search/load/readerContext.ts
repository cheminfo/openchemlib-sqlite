import type { DatabaseSync } from 'node:sqlite';

import type { Block, BlockViews, ColumnLayout } from '../blocks.ts';
import { blockViews } from '../blocks.ts';
import type { NormalizedSpec } from '../spec.ts';

/** What a load reader starts with. */
export interface ReaderData {
  file: string;
  layout: ColumnLayout;
  spec: NormalizedSpec;
  watermark: number;
}

/** A reader's connection and its views on the image's blocks. */
export class ReaderContext {
  readonly db: DatabaseSync;
  readonly data: ReaderData;
  #blocks: Block[] = [];
  #views: BlockViews[] = [];
  #starts = new Float64Array(0);

  /**
   * A reader's context.
   * @param db - The reader's connection, inside its read transaction.
   * @param data - The reader's start data.
   */
  constructor(db: DatabaseSync, data: ReaderData) {
    this.db = db;
    this.data = data;
  }

  /**
   * Sets the image's blocks.
   * @param blocks - The blocks, in row-space order.
   */
  setBlocks(blocks: Block[]): void {
    this.#blocks = blocks;
    this.#views = blocks.map((block) => blockViews(block, this.data.layout));
    this.#starts = Float64Array.from(blocks, (block) => block.start);
  }

  /**
   * A block's views.
   * @param b - The block.
   * @returns Its views.
   */
  views(b: number): BlockViews {
    return this.#views[b] as BlockViews;
  }

  /**
   * A block.
   * @param b - The block.
   * @returns It.
   */
  block(b: number): Block {
    return this.#blocks[b] as Block;
  }

  /**
   * The block holding a row of the row space.
   * @param g - The row.
   * @returns The block.
   */
  blockOf(g: number): number {
    const starts = this.#starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((starts[mid] as number) <= g) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * The tasks of a phase, pulled from a counter the readers share.
 * @param counter - The shared counter.
 * @param n - How many tasks.
 * @yields {number} The task numbers this reader takes.
 */
export function* pull(
  counter: SharedArrayBuffer,
  n: number,
): Generator<number> {
  const next = new Int32Array(counter);
  for (let t = Atomics.add(next, 0, 1); t < n; t = Atomics.add(next, 0, 1)) {
    yield t;
  }
}
