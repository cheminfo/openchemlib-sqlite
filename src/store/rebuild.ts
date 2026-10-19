import { availableParallelism } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

import { computeSignatures, computeStamp } from '../chemistry/stamp.ts';

import type { CountedFingerprint, Counting } from './bitCounts.ts';
import { ChemistryPool } from './chemistryPool.ts';
import { dropInSteps } from './dropInSteps.ts';
import { PRE_RELEASE_FILE, isPreRelease } from './metaChecks.ts';
import { RebuildRun } from './rebuildRun.ts';
import type { RebuildPlan } from './rebuildState.ts';
import { beginRebuild } from './rebuildState.ts';
import type { RebuildOptions, RebuildResult } from './rebuildTypes.ts';
import { updatesOf } from './rebuildTypes.ts';
import { hasStore, readMeta } from './schema.ts';
import { refuseV5 } from './v5Schema.ts';

/**
 * Brings a file to this build while the build that wrote it keeps serving it. A first pass builds,
 * beside the tiles in use, new ones (the same keys, slots and seqs, the fingerprints whose keys
 * changed computed again from the idCodes) and new counts. Writes go on meanwhile and log each tile
 * they change and each molecule they remove; catch-up rounds bring the new tiles up to date from
 * that log until little of it is left, and the last round, under the write lock, also puts the new
 * tiles and counts in place and raises the generation. Each step commits its progress: calling it
 * again resumes. The replaced tiles are freed afterwards, a step at a time.
 * @param db - A connection of its own, outside any transaction: the switch holds the write lock.
 * @param options - Threads, step size, cancellation and progress.
 * @returns What was done.
 */
export async function rebuildStore(
  db: DatabaseSync,
  options: RebuildOptions,
): Promise<RebuildResult> {
  const {
    threads = Math.max(1, availableParallelism() - 1),
    tilesPerStep = 256,
    signal,
    onProgress,
  } = options;
  refuseV5(db);
  if (!hasStore(db)) {
    throw new Error('the database holds no store of openchemlib-sqlite 6');
  }
  const signatures = await computeSignatures();
  const stamp = await computeStamp();
  await dropInSteps(db, 'ocl_tile_old');
  const meta = readMeta(db);
  if (isPreRelease(meta)) throw new Error(PRE_RELEASE_FILE);
  const updates = updatesOf(meta, signatures);
  if (updates.identity) {
    throw new Error(
      'the file holds molecules canonized or hashed differently from this build: commit its idCodes into a new file',
    );
  }
  const plan: RebuildPlan = {
    tiles: updates.tiles,
    counts: updates.counts,
    idCodeHash: updates.idCodeHash,
  };
  const target = JSON.stringify({ signatures, ...plan });
  if (meta.rebuild !== '' && meta.rebuild !== target) {
    throw new Error(
      'a rebuild for another build is under way: let it end, or call MoleculeStore.abandonRebuild()',
    );
  }
  const tiles = plan.tiles.length > 0 || plan.counts.length > 0;
  if (!tiles && !plan.idCodeHash) {
    return { rebuilt: [], counted: [], molecules: 0, hashed: 0 };
  }
  if (meta.rebuild === '') await dropInSteps(db, 'ocl_tile_next');
  const counting = countingFor(plan.counts);
  const run = new RebuildRun(
    db,
    beginRebuild(db, target, plan),
    {
      counting,
      need: {
        fragFp: plan.tiles.includes('fragFp'),
        screen: plan.tiles.includes('screen'),
        functions: plan.tiles.includes('functions'),
      },
      tiles,
      hashes: plan.idCodeHash,
    },
    { total: meta.count, listener: onProgress },
  );
  const pool = new ChemistryPool(threads);
  try {
    await run.hashPass(signal);
    await run.firstPass(pool, tilesPerStep, signal);
    await run.catchUp(pool, signal);
    run.switchOver(plan, { stamp, signatures });
  } finally {
    await pool.close();
  }
  await dropInSteps(db, 'ocl_tile_old');
  return {
    rebuilt: plan.tiles,
    counted: plan.counts,
    molecules: run.molecules,
    hashed: run.hashed,
  };
}

function countingFor(fingerprints: readonly CountedFingerprint[]): Counting {
  return {
    fragFp: fingerprints.includes('fragFp'),
    screen: fingerprints.includes('screen'),
    functions: fingerprints.includes('functions'),
  };
}
