import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { tileBytes, tileViews } from '../../chemistry/tileRecord.ts';
import { MoleculeStore } from '../MoleculeStore.ts';

import { commitIds, commitSteps } from './storeSteps.ts';

/** Stores in files of their own, in one directory, closed and removed together. */
export class StoreFiles {
  readonly directory: string;
  readonly #opened: Array<{ db: DatabaseSync; store: MoleculeStore }> = [];

  /**
   * A new directory.
   * @param prefix - The directory's name prefix.
   */
  constructor(prefix: string) {
    this.directory = mkdtempSync(join(tmpdir(), prefix));
  }

  /**
   * A store in a file of its own, holding molecules.
   * @param name - The file's name.
   * @param molecules - The idCodes to commit.
   * @returns The connection and the store.
   */
  async storeWith(
    name: string,
    molecules: readonly string[],
  ): Promise<{ db: DatabaseSync; store: MoleculeStore }> {
    const db = new DatabaseSync(join(this.directory, `${name}.sqlite`));
    db.exec('PRAGMA journal_mode = WAL');
    const store = await this.open(db);
    await commitIds(store, db, molecules);
    return { db, store };
  }

  /**
   * Opens a store on a connection, closed with the others.
   * @param db - The connection.
   * @param checkRows - Molecules recomputed at opening.
   * @returns The store.
   */
  async open(db: DatabaseSync, checkRows = 32): Promise<MoleculeStore> {
    const store = await MoleculeStore.open(db, {
      threads: testThreads(2),
      checkRows,
    });
    this.#opened.push({ db, store });
    return store;
  }

  /** Closes every store and connection, and removes the directory. */
  async close(): Promise<void> {
    for (const { store } of this.#opened) {
      // eslint-disable-next-line no-await-in-loop -- one store after the other
      await store.close();
    }
    for (const db of new Set(this.#opened.map((entry) => entry.db))) {
      db.close();
    }
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/**
 * Commits molecules, rolling back when the store refuses.
 * @param store - The store.
 * @param db - Its connection.
 * @param molecules - The idCodes.
 * @returns Why the store refused, or undefined when it did not.
 */
export async function refusal(
  store: MoleculeStore,
  db: DatabaseSync,
  molecules: readonly string[],
): Promise<string | undefined> {
  try {
    await commitSteps(store, db, molecules);
    return undefined;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    return (error as Error).message;
  }
}

/**
 * Writes one row of `ocl_meta`.
 * @param db - The connection.
 * @param name - The row.
 * @param value - Its value.
 */
export function setMeta(
  db: DatabaseSync,
  name: string,
  value: string | number,
): void {
  db.prepare('UPDATE ocl_meta SET value = ? WHERE name = ?').run(value, name);
}

/**
 * Puts other bits in some planes of every tile, as a build with other keys would have: each used
 * slot's bit flipped.
 * @param db - The connection.
 * @param from - The first plane.
 * @param to - The plane after the last.
 */
export function scramblePlanes(
  db: DatabaseSync,
  from: number,
  to: number,
): void {
  const update = db.prepare('UPDATE ocl_tile SET data = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, data FROM ocl_tile').all() as Array<{
    id: number;
    data: Uint8Array;
  }>) {
    const tile = tileViews(row.data);
    const used = tile.used[0] as number;
    const mask = used === 32 ? -1 : (1 << used) - 1;
    for (let plane = from; plane < to; plane++) {
      tile.planes[plane] = ~(tile.planes[plane] as number) & mask;
    }
    update.run(tileBytes(tile), row.id);
  }
}

/**
 * Takes the idCode hashes out of a file, as a build without them wrote it.
 * @param db - The connection.
 */
export function dropIdCodeHashes(db: DatabaseSync): void {
  db.exec('DROP INDEX ocl_molecule_idcode');
  db.exec('ALTER TABLE ocl_molecule DROP COLUMN idCodeHash');
}

/**
 * The ids of the stored molecules.
 * @param db - The connection.
 * @returns Them, in id order.
 */
export function idsOf(db: DatabaseSync): number[] {
  return (
    db.prepare('SELECT id FROM ocl_molecule ORDER BY id').all() as Array<{
      id: number;
    }>
  ).map((row) => row.id);
}

/**
 * The library's tables a file holds.
 * @param db - The connection.
 * @returns Their names, sorted.
 */
export function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) = 'ocl_' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}
