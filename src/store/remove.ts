import type { DatabaseSync } from 'node:sqlite';

import { getMoleculeSizes } from 'openchemlib-search-wasm';

import {
  FINGERPRINT_WORDS,
  FUNCTION_WORDS_AT,
  countKeys,
} from '../chemistry/bits.ts';
import { atomCountOf, seqOf } from '../chemistry/key.ts';
import {
  bandOfWeight,
  clearSlot,
  slotWords,
  tileKey,
} from '../chemistry/tile.ts';
import { tileBytes, tileViews } from '../chemistry/tileRecord.ts';

import {
  COUNTED_BITS,
  COUNTS_AT,
  addCounts,
  prepareAddCount,
} from './bitCounts.ts';
import { prepareTileLog } from './commit.ts';
import type { WriteCheck } from './writeState.ts';

/**
 * Removes molecules from the store, inside the caller's transaction: their `ocl_molecule` rows go
 * and their tile slots are emptied (the slot stays used, so its seq is never reused). A hash no
 * remaining molecule carries leaves its distinct count, and their FragFp, screen and function bits,
 * read from the slot, leave the bit counts. Meant for molecules the application has already removed
 * from its own tables: the in-memory index learns of a removal from the application's change log.
 * While a rebuild is under way, each tile changed is logged for it.
 * @param db - The connection, inside a transaction.
 * @param ids - The ids to remove; ids the store does not hold are ignored.
 * @param writable - Refuses the write when the file cannot take it, else says what it keeps.
 * @returns How many molecules were removed.
 */
export function removeMolecules(
  db: DatabaseSync,
  ids: readonly number[],
  writable: () => WriteCheck,
): number {
  if (!db.isTransaction) {
    throw new Error("remove() runs inside the caller's transaction");
  }
  const { counting, logging } = writable();
  const log = logging ? prepareTileLog(db) : null;
  const counts = new Float64Array(COUNTED_BITS);
  const read = db.prepare(
    'SELECT idCode, noStereoHash, tautomerHash FROM ocl_molecule WHERE id = ?',
  );
  read.setReadBigInts(true);
  const found: RemovedRow[] = [];
  for (const id of new Set(ids)) {
    const row = read.get(id) as Omit<RemovedRow, 'id'> | undefined;
    if (row !== undefined) found.push({ id, ...row });
  }
  if (found.length === 0) return 0;
  const { weights } = getMoleculeSizes(found.map((row) => row.idCode));
  const cells = new Map<number, number[]>();
  for (let i = 0; i < found.length; i++) {
    const { id } = found[i] as { id: number };
    const base = tileKey(
      atomCountOf(id),
      bandOfWeight(weights[i] as number),
      0,
    );
    let list = cells.get(base);
    if (list === undefined) cells.set(base, (list = []));
    list.push(id);
  }
  const tiles = db.prepare(
    'SELECT id, data FROM ocl_tile WHERE id >= ? AND id < ? ORDER BY id',
  );
  const update = db.prepare('UPDATE ocl_tile SET data = ? WHERE id = ?');
  for (const [base, list] of cells) {
    const wanted = new Set(list.map((id) => seqOf(id)));
    const cellEnd = base + tileKey(0, 1, 0);
    for (const row of tiles.all(base, cellEnd) as Array<{
      id: number;
      data: Uint8Array;
    }>) {
      const tile = tileViews(row.data);
      let changed = false;
      for (let slot = 0; slot < (tile.used[0] as number); slot++) {
        if (wanted.delete(tile.seqs[slot] as number)) {
          const words = slotWords(tile, slot);
          countKeys(counts, COUNTS_AT.fragFp, words, 0, -1);
          countKeys(counts, COUNTS_AT.screen, words, FINGERPRINT_WORDS, -1);
          countKeys(counts, COUNTS_AT.functions, words, FUNCTION_WORDS_AT, -1);
          clearSlot(tile, slot);
          changed = true;
        }
      }
      if (changed) {
        update.run(tileBytes(tile), row.id);
        log?.run(row.id);
      }
      if (wanted.size === 0) break;
    }
    if (wanted.size > 0) {
      throw new Error(
        `no tile slot holds seq ${[...wanted][0]}: the file is inconsistent`,
      );
    }
  }
  addCounts(prepareAddCount(db), counts, counting);
  const remove = db.prepare('DELETE FROM ocl_molecule WHERE id = ?');
  for (const { id } of found) remove.run(id);
  const subtract = db.prepare(
    'UPDATE ocl_meta SET value = value - ? WHERE name = ?',
  );
  subtract.run(found.length, 'count');
  subtract.run(
    gone(
      db,
      'noStereoHash',
      found.map((row) => row.noStereoHash),
    ),
    'distinctNoStereo',
  );
  subtract.run(
    gone(
      db,
      'tautomerHash',
      found.map((row) => row.tautomerHash),
    ),
    'distinctTautomer',
  );
  return found.length;
}

/** A molecule being removed, with its two identity hashes. */
interface RemovedRow {
  id: number;
  idCode: string;
  noStereoHash: bigint;
  tautomerHash: bigint;
}

/**
 * How many of the removed molecules' hashes no remaining molecule carries.
 * @param db - The connection, after the rows are deleted.
 * @param column - The hash column.
 * @param hashes - The hashes the removed molecules carried.
 * @returns The distinct hashes gone from the store.
 */
function gone(
  db: DatabaseSync,
  column: 'noStereoHash' | 'tautomerHash',
  hashes: readonly bigint[],
): number {
  const still = db.prepare(
    `SELECT 1 AS found FROM ocl_molecule WHERE ${column} = ? LIMIT 1`,
  );
  let count = 0;
  for (const hash of new Set(hashes)) {
    if (still.get(hash) === undefined) count++;
  }
  return count;
}
