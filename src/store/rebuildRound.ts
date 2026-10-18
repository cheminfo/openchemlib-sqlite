import type { StatementSync } from 'node:sqlite';

import { FINGERPRINT_WORDS, countBits } from '../chemistry/bits.ts';
import { makeId } from '../chemistry/key.ts';
import type {
  FingerprintColumns,
  FingerprintNeed,
} from '../chemistry/records.ts';
import type { TileViews } from '../chemistry/tile.ts';
import {
  clearSlot,
  copyTile,
  slotWords,
  splitTileKey,
  tileViews,
  writeSlot,
} from '../chemistry/tile.ts';
import { countTileKeys } from '../chemistry/tileWords.ts';

import type { Counting } from './bitCounts.ts';
import { COUNTED_BITS, addCounts } from './bitCounts.ts';
import type { TileUpdate } from './rebuildPass.ts';
import { addFunctions, emptyTile, replaceWords } from './rebuildPass.ts';
import type { RebuildStatements } from './rebuildStatements.ts';
import { idCodeOf, removedIdCode } from './rebuildStatements.ts';

/** A tile changed since its new tile was built. */
export interface ChangedTile {
  key: number;
  /** The tile in use now. */
  source: TileViews;
  /** Its new tile, null when none was built. */
  old: TileViews | null;
}

/** What a catch-up round brings up to date. */
export interface Round {
  /** The last change of the log it covers. */
  logSeq: number;
  tiles: ChangedTile[];
  /** Molecules a tile in use holds and its new tile lacks. */
  added: Array<{ t: number; slot: number; id: number }>;
  /** Molecules a new tile holds and its tile in use no longer does. */
  removed: Array<{ t: number; slot: number; id: number }>;
}

/** The reads of a catch-up round. */
export interface RoundReads {
  changes: StatementSync;
  source: StatementSync;
  next: StatementSync;
}

/**
 * Reads the tiles the log says changed since their new tiles were built, and tells, slot by slot,
 * which molecules arrived and which left: slots are taken in order and never reused, so a slot
 * either holds the same seq in both, or one of them is empty.
 * @param reads - The statements.
 * @param limit - The most log rows read.
 * @returns The round, or null when the log is empty.
 */
export function planRound(reads: RoundReads, limit: number): Round | null {
  const changes = reads.changes.all(limit) as Array<{
    seq: number;
    id: number;
  }>;
  if (changes.length === 0) return null;
  const round: Round = {
    logSeq: (changes.at(-1) as { seq: number }).seq,
    tiles: [],
    added: [],
    removed: [],
  };
  for (const key of new Set(changes.map((change) => change.id))) {
    const row = reads.source.get(key) as { data: Uint8Array } | undefined;
    if (row === undefined) throw new Error(`tile ${key} is logged, not stored`);
    const source = tileViews(row.data);
    const next = reads.next.get(key) as { data: Uint8Array } | undefined;
    const old = next === undefined ? null : tileViews(next.data);
    const t = round.tiles.push({ key, source, old }) - 1;
    const { atoms } = splitTileKey(key);
    const oldUsed = old === null ? 0 : (old.used[0] as number);
    for (let slot = 0; slot < (source.used[0] as number); slot++) {
      const now = source.seqs[slot] as number;
      const before = slot < oldUsed ? (old?.seqs[slot] as number) : 0;
      if (now === before) continue;
      if (before === 0) {
        round.added.push({ t, slot, id: makeId(atoms, now) });
      } else if (now === 0) {
        round.removed.push({ t, slot, id: makeId(atoms, before) });
      } else {
        throw new Error(
          `slot ${slot} of tile ${key} holds ${now}, not ${before}`,
        );
      }
    }
  }
  return round;
}

/**
 * The new tiles of a round: each built again from its previous version, the molecules that
 * arrived written in their slots, those that left cleared; and what that changes in the counts.
 * @param round - The round.
 * @param added - The fingerprints of the molecules that arrived, in round order.
 * @param removedFunctions - The function bits of those that left, null when not counted.
 * @returns The update.
 */
export function roundTiles(
  round: Round,
  added: FingerprintColumns | null,
  removedFunctions: Int32Array | null,
): TileUpdate {
  const counts = new Float64Array(COUNTED_BITS);
  const fresh = round.tiles.map(({ source, old }) => {
    const tile = old === null ? emptyTile(0) : copyTile(old);
    tile.used[0] = source.used[0] as number;
    return tile;
  });
  for (const [m, { t, slot }] of round.added.entries()) {
    const { source } = round.tiles[t] as ChangedTile;
    const words = slotWords(source, slot);
    replaceWords(words, 0, added?.fragFp ?? null, m);
    replaceWords(words, FINGERPRINT_WORDS, added?.screen ?? null, m);
    const bits = countBits(words, 0, FINGERPRINT_WORDS);
    const seq = source.seqs[slot] as number;
    writeSlot(fresh[t] as TileViews, slot, words, 0, seq, bits);
  }
  for (const { t, slot } of round.removed) {
    clearSlot(fresh[t] as TileViews, slot);
  }
  for (const [t, { old }] of round.tiles.entries()) {
    if (old !== null) countTileKeys(counts, old, -1);
    countTileKeys(counts, fresh[t] as TileViews);
  }
  addFunctions(counts, added?.functions ?? null, round.added.length, 1);
  addFunctions(counts, removedFunctions, round.removed.length, -1);
  return {
    tiles: fresh.map((tile, t) => [
      (round.tiles[t] as ChangedTile).key,
      tile.data,
    ]),
    counts,
    molecules: round.added.length,
  };
}

/** A round, and the idCodes of the molecules it computes. */
export interface PlannedRound {
  round: Round;
  /** The molecules that arrived, when fingerprints are computed. */
  added: string[];
  /** The molecules that left, when function bits are counted. */
  removed: string[];
}

/**
 * Plans a round and reads the idCodes it computes from.
 * @param statements - The statements of the rebuild.
 * @param need - The fingerprints computed.
 * @param limit - The most log rows read.
 * @returns The round, or null when the log is empty.
 */
export function planWithIdCodes(
  statements: RebuildStatements,
  need: FingerprintNeed,
  limit: number,
): PlannedRound | null {
  const round = planRound(statements, limit);
  if (round === null) return null;
  const chemistry = need.fragFp || need.screen || need.functions;
  return {
    round,
    added: chemistry
      ? round.added.map(({ id }) => idCodeOf(statements, id))
      : [],
    removed: need.functions
      ? round.removed.map(({ id }) => removedIdCode(statements, id))
      : [],
  };
}

/**
 * Writes a round's tiles and counts, inside the caller's transaction, and empties the log rows it
 * covered.
 * @param statements - The statements of the rebuild.
 * @param round - The round.
 * @param update - Its tiles and counts.
 * @param counting - The fingerprints counted.
 * @param done - The molecules done once it is written.
 */
export function applyRound(
  statements: RebuildStatements,
  round: Round,
  update: TileUpdate,
  counting: Counting,
  done: number,
): void {
  for (const [key, data] of update.tiles) {
    statements.upsertTile.run(key, data);
  }
  addCounts(statements.addCount, update.counts, counting);
  statements.deleteChanges.run(round.logSeq);
  for (const { id } of round.removed) statements.deleteRemoved.run(id);
  statements.setMeta.run('rebuild.done', done);
}
