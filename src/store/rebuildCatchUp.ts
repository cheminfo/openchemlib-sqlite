import type { DatabaseSync } from 'node:sqlite';

import type {
  FingerprintColumns,
  FingerprintNeed,
} from '../chemistry/records.ts';
import { computeFingerprints } from '../chemistry/records.ts';

import type { Counting } from './bitCounts.ts';
import type { ChemistryPool } from './chemistryPool.ts';
import type { PlannedRound } from './rebuildRound.ts';
import { applyRound, planWithIdCodes, roundTiles } from './rebuildRound.ts';
import type { RebuildStatements } from './rebuildStatements.ts';
import { read } from './rebuildStatements.ts';

/** Log rows a catch-up round reads at most. */
const ROUND_CHANGES = 4096;

/** What a round computes, where it writes, and who hears of it. */
export interface RoundContext {
  tiles: RebuildStatements;
  need: FingerprintNeed;
  counting: Counting;
  /** The molecules done so far. */
  done: () => number;
  /** Hears each round, with the molecules it computed. */
  report: (molecules: number) => void;
}

/**
 * One catch-up round: the log read in one read transaction, its molecules computed in the
 * workers, its tiles and counts written in a transaction of its own.
 * @param context - The round's context.
 * @param db - The connection.
 * @param pool - The chemistry workers.
 * @param write - Runs work in a write transaction of the rebuild.
 * @returns False when the log was empty.
 */
export async function catchUpRound(
  context: RoundContext,
  db: DatabaseSync,
  pool: ChemistryPool,
  write: (work: () => void) => void,
): Promise<boolean> {
  const { tiles, need, counting } = context;
  const planned = read(db, () => planWithIdCodes(tiles, need, ROUND_CHANGES));
  if (planned === null) return false;
  const chemistry = need.fragFp || need.screen || need.functions;
  const added =
    chemistry && planned.added.length > 0
      ? await pool.fingerprints(planned.added, need)
      : null;
  const update = roundTiles(planned.round, added);
  const done = context.done() + update.molecules;
  write(() => applyRound(tiles, planned.round, update, counting, done));
  context.report(update.molecules);
  return true;
}

/**
 * Every round the log still holds, inside the caller's write transaction, their molecules
 * computed on this thread: nothing else runs on the connection meanwhile.
 * @param context - The rounds' context.
 */
export function finalRounds(context: RoundContext): void {
  const { tiles, need, counting } = context;
  const chemistry = need.fragFp || need.screen || need.functions;
  for (;;) {
    const planned: PlannedRound | null = planWithIdCodes(
      tiles,
      need,
      Number.MAX_SAFE_INTEGER,
    );
    if (planned === null) return;
    const added: FingerprintColumns | null =
      chemistry && planned.added.length > 0
        ? computeFingerprints(planned.added, need)
        : null;
    const update = roundTiles(planned.round, added);
    applyRound(
      tiles,
      planned.round,
      update,
      counting,
      context.done() + update.molecules,
    );
    context.report(update.molecules);
  }
}
