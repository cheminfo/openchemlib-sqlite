import { availableParallelism } from 'node:os';

import type { LoadProgressListener } from './load/loadProgress.ts';
import { ignoreProgress } from './load/loadProgress.ts';

/** Options of `MoleculeIndex.open()`. */
export interface MoleculeIndexOptions {
  /**
   * Search worker threads.
   * @default availableParallelism() - 1, at least 1
   */
  threads?: number;
  /**
   * Threads reading the file at load.
   * @default threads
   */
  readers?: number;
  /**
   * Rows of a block at most.
   * @default 4194304
   */
  blockRows?: number;
  /**
   * Rows of the first slice of a walk; each next slice holds twice the last.
   * @default 65536
   */
  firstSliceRows?: number;
  /**
   * Plane words per similarity unit.
   * @default 8192
   */
  similarityUnitWords?: number;
  /**
   * Rows of one chunk of a count, about: each chunk is a turn of the count's lane.
   * @default 33554432
   */
  countChunkRows?: number;
  /**
   * The budget of a page, in milliseconds.
   * @default 4500
   */
  budgetMs?: number;
  /**
   * Whether to follow the file's commits.
   * @default true
   */
  follow?: boolean;
  /**
   * Milliseconds between polls of the file.
   * @default 500
   */
  pollMs?: number;
  /**
   * Seqs a poll reads at most, 0 for no limit.
   * @default 0
   */
  pollRows?: number;
  /**
   * Rows of an atom count's first append block.
   * @default 4096
   */
  appendBlockRows?: number;
  /**
   * Rows of headroom in the bitmaps when they grow, at least.
   * @default 65536
   */
  headroomRows?: number;
  /**
   * The share of the row space added to the bitmaps when they grow.
   * @default 0.05
   */
  headroomShare?: number;
  /**
   * Changes a poll reads at most.
   * @default 200000
   */
  changeBatch?: number;
  /**
   * Milliseconds after a page's deadline before a verification still running is killed.
   * @default 1000
   */
  watchdogGraceMs?: number;
  /**
   * A verification chunk may run at least this many milliseconds.
   * @default 1500
   */
  verifyChunkMinMs?: number;
  /**
   * Or this multiple of the search's verification time per candidate times its candidates.
   * @default 16
   */
  verifyChunkFactor?: number;
  /**
   * A candidate verified alone may run this many milliseconds.
   * @default 1000
   */
  verifySingleMs?: number;
  /**
   * Hears how far the load got: each step as it starts, how many of its tasks the readers took
   * five times a second, and its end; then each later save of the snapshot, as the step `save`.
   * It runs on the thread opening the index.
   * @default a function doing nothing
   */
  onProgress?: LoadProgressListener;
  /**
   * A file the index is saved to, and read back from at the next open: one sequential read
   * instead of the store's tables, whose pages a large store scatters over its file. It holds about
   * 200 bytes per molecule. Empty, the index is loaded from the store at every open.
   * @default ''
   */
  snapshot?: string;
  /**
   * Once the tail has placed, or read again from the change log, this share of the snapshot's
   * rows, the index is saved to it again, as a load lays it out, as soon as the tail caught up.
   * @default 0.05
   */
  snapshotRefreshShare?: number;
  /**
   * Once the store holds more new molecules than this share of the snapshot's rows, the index is
   * loaded from the store again and saved anew, rather than the tail catching up from it.
   * @default 1
   */
  snapshotStaleShare?: number;
}

/**
 * The options with every default filled in; an option given as undefined takes its default.
 * @param options - The options given.
 * @returns Every option.
 */
export function settleOptions(
  options: MoleculeIndexOptions,
): Required<MoleculeIndexOptions> {
  const threads = options.threads ?? Math.max(1, availableParallelism() - 1);
  return {
    threads,
    readers: options.readers ?? threads,
    blockRows: options.blockRows ?? 2 ** 22,
    firstSliceRows: options.firstSliceRows ?? 65_536,
    similarityUnitWords: options.similarityUnitWords ?? 8192,
    countChunkRows: options.countChunkRows ?? 2 ** 25,
    budgetMs: options.budgetMs ?? 4500,
    follow: options.follow ?? true,
    pollMs: options.pollMs ?? 500,
    pollRows: options.pollRows ?? 0,
    appendBlockRows: options.appendBlockRows ?? 4096,
    headroomRows: options.headroomRows ?? 65_536,
    headroomShare: options.headroomShare ?? 0.05,
    changeBatch: options.changeBatch ?? 200_000,
    watchdogGraceMs: options.watchdogGraceMs ?? 1000,
    verifyChunkMinMs: options.verifyChunkMinMs ?? 1500,
    verifyChunkFactor: options.verifyChunkFactor ?? 16,
    verifySingleMs: options.verifySingleMs ?? 1000,
    onProgress: options.onProgress ?? ignoreProgress,
    snapshot: options.snapshot ?? '',
    snapshotRefreshShare: options.snapshotRefreshShare ?? 0.05,
    snapshotStaleShare: options.snapshotStaleShare ?? 1,
  };
}
