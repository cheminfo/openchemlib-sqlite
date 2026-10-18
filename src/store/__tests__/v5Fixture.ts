import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';

import { testThreads } from '../../__tests__/testDatabase.ts';

/**
 * A file openchemlib-sqlite 5.3.0 wrote, configured with entriesTable `molecules`, pkColumn `id`,
 * idCodeColumn `id_code` and mwColumn `mf_molecular_weight`, after migrate(), insert(),
 * foldPlanes() and backfillHashes(): its six entries are ethanol, benzene, acetic acid, L- and
 * D-alanine and aspirin, ids 1 to 6.
 */
export const FIXTURE = join(
  import.meta.dirname,
  '../../__tests__/data/v5.sqlite',
);
export const ENTRIES = { table: 'molecules', key: 'id', idCode: 'id_code' };
export const THREADS = testThreads(2);

const directories: string[] = [];

/** Deletes the copies {@link fiveFile} made: call it after each test. */
export function removeFiveFiles(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A copy of the 5.x file, as its application opens it.
 * @returns The connection and the file.
 */
export function fiveFile(): { db: DatabaseSync; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ocl-v5-'));
  directories.push(directory);
  const file = join(directory, 'db.sqlite');
  copyFileSync(FIXTURE, file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  return { db, file };
}

/**
 * The canonical idCode of a structure.
 * @param smiles - The structure.
 * @returns Its idCode.
 */
export function idCodeOf(smiles: string): string {
  return OCL.Molecule.fromSmiles(smiles).getIDCode();
}

/**
 * What `ocl_v5_ids` holds.
 * @param db - The connection.
 * @returns Its rows, by entry.
 */
export function idsOf(db: DatabaseSync) {
  return db
    .prepare('SELECT entry, id, error FROM ocl_v5_ids ORDER BY entry')
    .all()
    .map((row) => ({ ...row }));
}
