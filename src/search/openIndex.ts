import { computeStamp } from '../chemistry/stamp.ts';
import { validateStamp } from '../store/metaChecks.ts';
import { readMeta } from '../store/schema.ts';
import { refuseV5 } from '../store/v5Schema.ts';

import type { MoleculeIndexOptions } from './indexOptions.ts';
import { settleOptions } from './indexOptions.ts';
import type { Layout } from './layout.ts';
import type { LoadedImage } from './load/loadImage.ts';
import { runStep } from './load/loadProgress.ts';
import { openReader } from './load/plan.ts';
import { SearchPool } from './pool/SearchPool.ts';
import { openImage } from './snapshot/openImage.ts';
import { SnapshotKeeper } from './snapshot/snapshotKeeper.ts';
import type { IndexSpec, NormalizedSpec } from './spec.ts';
import { normalizeSpec } from './spec.ts';
import { Tail } from './tail/Tail.ts';

/** What an index is made of. */
export interface IndexParts {
  image: LoadedImage;
  spec: NormalizedSpec;
  pool: SearchPool;
  tail: Tail | null;
  /** Saves the snapshot again as the tail grows the image; null without a snapshot or a tail. */
  keeper: SnapshotKeeper | null;
  options: Required<MoleculeIndexOptions>;
  /** Hears each version the tail publishes, once the index exists. */
  relay: { onLayout: (layout: Layout) => void };
}

/**
 * Checks the file's stamp, loads its image (or reads it back from its snapshot), starts the tail
 * and the search workers.
 * @param file - The SQLite file the store writes.
 * @param spec - The application's specification.
 * @param options - The index's options.
 * @returns The parts, ready.
 */
export async function openParts(
  file: string,
  spec: IndexSpec,
  options: MoleculeIndexOptions,
): Promise<IndexParts> {
  const settled = settleOptions(options);
  const normalized = normalizeSpec(spec);
  const stamp = await computeStamp();
  const db = openReader(file);
  try {
    refuseV5(db);
    validateStamp(readMeta(db), stamp);
  } finally {
    db.close();
  }
  const image = await openImage(file, normalized, settled);
  const relay: IndexParts['relay'] = { onLayout: ignore };
  const holder: { pool: SearchPool | null } = { pool: null };
  // Only what the tail's worker reads: a listener cannot cross into a thread.
  const tailOptions = {
    pollMs: settled.pollMs,
    appendBlockRows: settled.appendBlockRows,
    blockRows: settled.blockRows,
    headroomRows: settled.headroomRows,
    headroomShare: settled.headroomShare,
    pollRows: settled.pollRows,
    changeBatch: settled.changeBatch,
    stamp,
  };
  const tail = settled.follow
    ? new Tail(file, image, normalized, tailOptions, (layout, message) => {
        // The workers know the new blocks before any search reads the version holding them.
        holder.pool?.addBlocks(message.newBlocks);
        relay.onLayout(layout);
      })
    : null;
  const keeper =
    tail !== null && settled.snapshot !== ''
      ? new SnapshotKeeper({
          path: settled.snapshot,
          file,
          spec: normalized,
          tail,
          sizes: {
            blockRows: settled.blockRows,
            headroomRows: settled.headroomRows,
            headroomShare: settled.headroomShare,
          },
          refreshShare: settled.snapshotRefreshShare,
          listener: settled.onProgress,
          rows: image.stats.rows,
        })
      : null;
  if (tail !== null && keeper !== null) {
    tail.onCounters = (counters) => keeper.onCounters(counters);
  }
  let pool: SearchPool | null = null;
  try {
    if (tail !== null) {
      await runStep(settled.onProgress, 'tail', () => tail.ready);
    }
    pool = startPool(file, normalized, settled, tail?.current ?? image.layout);
    holder.pool = pool;
    await runStep(
      settled.onProgress,
      'workers',
      () => (pool as SearchPool).ready,
    );
  } catch (error) {
    // Nothing of a failed open keeps running.
    await keeper?.close();
    await tail?.close().catch(() => undefined);
    await pool?.close();
    throw error;
  }
  return {
    image,
    spec: normalized,
    pool,
    tail,
    keeper,
    options: settled,
    relay,
  };
}

function startPool(
  file: string,
  spec: NormalizedSpec,
  settled: Required<MoleculeIndexOptions>,
  current: Layout,
): SearchPool {
  return new SearchPool({
    threads: settled.threads,
    file,
    layout: current.layout,
    columnsSql: spec.columnsSql,
    blocks: current.blocks.map((block, index) => ({ ...block, index })),
    watchdogGraceMs: settled.watchdogGraceMs,
    stopMarginMs: 5,
  });
}

function ignore(): void {
  // No index hears the tail yet.
}
