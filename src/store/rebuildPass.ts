import { FINGERPRINT_WORDS, countBits, countKeys } from '../chemistry/bits.ts';
import { makeId } from '../chemistry/key.ts';
import type {
  FingerprintColumns,
  FingerprintNeed,
} from '../chemistry/records.ts';
import type { TileViews } from '../chemistry/tile.ts';
import {
  MOLECULE_WORDS,
  TILE_BYTES,
  copyTile,
  splitTileKey,
  tileViews,
  writeSlot,
} from '../chemistry/tile.ts';
import { countTileKeys, tileWords } from '../chemistry/tileWords.ts';

import type { Counting } from './bitCounts.ts';
import { COUNTED_BITS, COUNTS_AT, addCounts } from './bitCounts.ts';
import type { RebuildStatements } from './rebuildStatements.ts';
import { idCodeOf } from './rebuildStatements.ts';

/** New tiles, and what they change in the counts. */
export interface TileUpdate {
  /** The new tiles, by key. */
  tiles: Array<[number, Uint8Array]>;
  /** What each count changes by. */
  counts: Float64Array;
  /** Molecules computed. */
  molecules: number;
}

/** A step of the first pass, as read. */
export interface FirstPassStep {
  keys: number[];
  tiles: TileViews[];
  /** The idCodes of their molecules, in {@link liveIds} order; none without chemistry. */
  idCodes: string[];
}

/**
 * Reads a step of the first pass: the next tiles in use, and the idCodes of their molecules when
 * fingerprints are computed. Run it in one read transaction, so every molecule has its idCode.
 * @param statements - The statements of the rebuild.
 * @param cursor - The last tile key built.
 * @param tilesPerStep - Tiles per step.
 * @param chemistry - Whether fingerprints are computed.
 * @returns The step; no keys once the tiles in use are all built.
 */
export function readFirstPassStep(
  statements: RebuildStatements,
  cursor: number,
  tilesPerStep: number,
  chemistry: boolean,
): FirstPassStep {
  const rows = statements.readTiles.all(cursor, tilesPerStep) as Array<{
    id: number;
    data: Uint8Array;
  }>;
  const keys = rows.map((row) => row.id);
  const tiles = rows.map((row) => tileViews(row.data));
  const ids = chemistry ? liveIds(keys, tiles) : [];
  return { keys, tiles, idCodes: ids.map((id) => idCodeOf(statements, id)) };
}

/**
 * Writes a step of the first pass, inside the caller's transaction: its new tiles, what they add
 * to the counts, and where the pass is.
 * @param statements - The statements of the rebuild.
 * @param update - The step's tiles and counts.
 * @param counting - The fingerprints counted.
 * @param progress - The last tile key built, and the molecules done.
 * @param progress.cursor - The last tile key built.
 * @param progress.done - The molecules done.
 */
export function writeFirstPassStep(
  statements: RebuildStatements,
  update: TileUpdate,
  counting: Counting,
  progress: { cursor: number; done: number },
): void {
  for (const [key, data] of update.tiles) {
    statements.insertTile.run(key, data);
  }
  addCounts(statements.addCount, update.counts, counting);
  statements.setMeta.run('rebuild.cursor', progress.cursor);
  statements.setMeta.run('rebuild.done', progress.done);
}

/**
 * The ids of the molecules tiles hold, tile after tile, slot after slot.
 * @param keys - The tiles' keys.
 * @param tiles - The tiles.
 * @returns The ids.
 */
export function liveIds(
  keys: readonly number[],
  tiles: readonly TileViews[],
): number[] {
  const ids: number[] = [];
  for (const [t, tile] of tiles.entries()) {
    const { atoms } = splitTileKey(keys[t] as number);
    for (let slot = 0; slot < (tile.used[0] as number); slot++) {
      const seq = tile.seqs[slot] as number;
      if (seq !== 0) ids.push(makeId(atoms, seq));
    }
  }
  return ids;
}

/**
 * The new tiles of a step of the first pass: the same keys, slots and seqs, the recomputed
 * fingerprints over the stored ones, a copy where nothing is recomputed; and what they add to the
 * counts, FragFp and screen from their planes, the function bits from the computed words.
 * @param keys - The tiles' keys.
 * @param tiles - The tiles in use.
 * @param computed - The fingerprints of their molecules, in {@link liveIds} order.
 * @param need - What was computed.
 * @returns The update.
 */
export function firstPassTiles(
  keys: readonly number[],
  tiles: readonly TileViews[],
  computed: FingerprintColumns | null,
  need: FingerprintNeed,
): TileUpdate {
  const counts = new Float64Array(COUNTED_BITS);
  const built: Array<[number, Uint8Array]> = [];
  let m = 0;
  for (const [t, tile] of tiles.entries()) {
    const used = tile.used[0] as number;
    let fresh = tile;
    if (computed !== null && (need.fragFp || need.screen)) {
      fresh = emptyTile(used);
      const words = tileWords(tile);
      for (let slot = 0; slot < used; slot++) {
        const seq = tile.seqs[slot] as number;
        if (seq === 0) continue;
        const at = slot * MOLECULE_WORDS;
        replaceWords(words, at, computed.fragFp, m);
        replaceWords(words, at + FINGERPRINT_WORDS, computed.screen, m);
        const bits = countBits(words, at, at + FINGERPRINT_WORDS);
        writeSlot(fresh, slot, words, at, seq, bits);
        m++;
      }
    } else {
      fresh = copyTile(tile);
    }
    countTileKeys(counts, fresh);
    built.push([keys[t] as number, fresh.data]);
  }
  const molecules = liveIds(keys, tiles).length;
  addFunctions(counts, computed?.functions ?? null, molecules, 1);
  return { tiles: built, counts, molecules };
}

/**
 * An empty tile.
 * @param used - The slots it says it uses.
 * @returns Its views.
 */
export function emptyTile(used: number): TileViews {
  const tile = tileViews(new Uint8Array(TILE_BYTES));
  tile.used[0] = used;
  return tile;
}

/**
 * Puts a molecule's recomputed fingerprint over the one its tile held.
 * @param words - Words, 32 per molecule.
 * @param at - Where the fingerprint starts in them.
 * @param computed - 16 words per molecule, or null when it was not recomputed.
 * @param m - The molecule.
 */
export function replaceWords(
  words: Int32Array,
  at: number,
  computed: Int32Array | null,
  m: number,
): void {
  if (computed === null) return;
  const from = m * FINGERPRINT_WORDS;
  words.set(computed.subarray(from, from + FINGERPRINT_WORDS), at);
}

/**
 * Adds molecules' function bits to the counts, or takes them away.
 * @param counts - The counts.
 * @param functions - 16 words per molecule, or null when not counted.
 * @param molecules - How many molecules.
 * @param sign - 1 adds them, -1 takes them away.
 */
export function addFunctions(
  counts: Float64Array,
  functions: Int32Array | null,
  molecules: number,
  sign: number,
): void {
  if (functions === null) return;
  for (let m = 0; m < molecules; m++) {
    countKeys(
      counts,
      COUNTS_AT.functions,
      functions,
      m * FINGERPRINT_WORDS,
      sign,
    );
  }
}
