import type { SQLInputValue } from 'node:sqlite';

import type { RecordColumns } from '../chemistry/records.ts';

import type { ReaderPool } from './readerPool.ts';

/** A read of the application's, run once per key ahead of a commit. */
export interface PrefetchRead {
  /** A statement taking one parameter; its rows are dropped. */
  sql: string;
  /** Its parameters, one run each. */
  keys: SQLInputValue[];
}

/**
 * Reads, with the readers, the pages of the three hash indexes where a commit of the batch seeks
 * and writes its molecules, and runs the application's reads.
 * @param readers - The readers; without them, nothing is read.
 * @param columns - What the batch holds, or undefined for a batch this store did not prepare.
 * @param reads - The application's reads.
 * @returns Once read.
 */
export async function prefetchBatch(
  readers: ReaderPool | undefined,
  columns: RecordColumns | undefined,
  reads: readonly PrefetchRead[],
): Promise<void> {
  if (readers === undefined) return;
  const noStereo: bigint[] = [];
  const tautomer: bigint[] = [];
  const idCode: bigint[] = [];
  if (columns !== undefined) {
    for (let i = 0; i < columns.idCodes.length; i++) {
      if (columns.errors[i] !== null) continue;
      noStereo.push(columns.noStereoHashes[i] as bigint);
      tautomer.push(columns.tautomerHashes[i] as bigint);
      idCode.push(columns.idCodeHashes[i] as bigint);
    }
  }
  await Promise.all([
    readers.touch(noStereo, tautomer, idCode),
    ...reads.map((read) => readers.read(read.sql, read.keys)),
  ]);
}
