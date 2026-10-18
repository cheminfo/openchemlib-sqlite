import type { DatabaseSync } from 'node:sqlite';

import { getFunctions, getIndexes, getScreens } from 'openchemlib-search-wasm';

import { countKeys } from '../../chemistry/bits.ts';
import type { BitCounts } from '../bitCounts.ts';

/**
 * The bit counts recomputed from every stored idCode, with the dedicated calls of
 * openchemlib-search-wasm.
 * @param db - The store's connection.
 * @returns What `bitCounts()` must answer.
 */
export function bruteCounts(db: DatabaseSync): BitCounts {
  const idCodes = (
    db.prepare('SELECT idCode FROM ocl_molecule').all() as Array<{
      idCode: string;
    }>
  ).map((row) => row.idCode);
  const counts = {
    molecules: idCodes.length,
    fragFp: new Float64Array(512),
    screen: new Float64Array(512),
    functions: new Float64Array(512),
  };
  const fragFp = getIndexes(idCodes);
  const screen = getScreens(idCodes);
  const functions = getFunctions(idCodes);
  for (let i = 0; i < idCodes.length; i++) {
    countKeys(counts.fragFp, 0, fragFp[i] as Int32Array, 0, 1);
    countKeys(counts.screen, 0, screen[i] as Int32Array, 0, 1);
    countKeys(counts.functions, 0, functions[i] as Int32Array, 0, 1);
  }
  return counts;
}
