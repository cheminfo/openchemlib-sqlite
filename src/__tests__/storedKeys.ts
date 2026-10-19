import type { DatabaseSync } from 'node:sqlite';

import { makeId } from '../chemistry/key.ts';
import { MOLECULE_WORDS, splitTileKey } from '../chemistry/tile.ts';
import { tileViews } from '../chemistry/tileRecord.ts';
import { tileWords } from '../chemistry/tileWords.ts';

/**
 * The 48 words of every stored molecule, read back from its tile slot: the record
 * `getMoleculeRecords` gave when the molecule was committed, which the opening check of every store
 * compares with what this build computes. Reading them costs nothing; computing them again would
 * cost about 4 ms a molecule.
 * @param db - The test database.
 * @returns The words, by id.
 */
export function storedKeys(db: DatabaseSync): Map<number, Int32Array> {
  const keys = new Map<number, Int32Array>();
  for (const row of db
    .prepare('SELECT id, data FROM ocl_tile')
    .iterate() as Iterable<{
    id: number;
    data: Uint8Array;
  }>) {
    const { atoms } = splitTileKey(row.id);
    const tile = tileViews(row.data);
    const words = tileWords(tile);
    const used = tile.used[0] as number;
    for (let slot = 0; slot < used; slot++) {
      const seq = tile.seqs[slot] as number;
      if (seq === 0) continue;
      const at = slot * MOLECULE_WORDS;
      keys.set(makeId(atoms, seq), words.slice(at, at + MOLECULE_WORDS));
    }
  }
  return keys;
}
