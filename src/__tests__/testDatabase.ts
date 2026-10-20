import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { XSadd } from 'ml-xsadd';
import * as OCL from 'openchemlib';

import type { IndexSpec } from '../search/spec.ts';
import type { MoleculeStore } from '../store/MoleculeStore.ts';

/**
 * Worker threads for a test: as many as it asks for, at most `WORKER_THREADS` when that is set
 * (a busy machine).
 * @param wanted - The threads the test asks for.
 * @returns The threads it gets.
 */
export function testThreads(wanted: number): number {
  const cap = Number(process.env.WORKER_THREADS);
  return cap > 0 ? Math.min(wanted, cap) : wanted;
}

/**
 * The application's side of a test database: its order key (`weight`, standing in for
 * formulas.mw), three filter columns of three types, sources (two public, one private), the
 * `listed` flag kept by triggers, and the change log the index follows.
 */
export const APP_SQL: readonly string[] = [
  `CREATE TABLE molecules (
    id INTEGER PRIMARY KEY,
    weight REAL NOT NULL,
    logP REAL,
    hba INTEGER,
    charge INTEGER,
    listed INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL, isPublic INTEGER NOT NULL)',
  `CREATE TABLE molecule_sources (
    sourceId INTEGER NOT NULL,
    moleculeId INTEGER NOT NULL,
    PRIMARY KEY (sourceId, moleculeId)
  ) WITHOUT ROWID`,
  'CREATE TABLE entry_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, moleculeId INTEGER NOT NULL)',
  `CREATE TRIGGER entries_insert AFTER INSERT ON molecule_sources BEGIN
    INSERT INTO entry_changes (moleculeId) VALUES (NEW.moleculeId);
    UPDATE molecules SET listed = 1
      WHERE id = NEW.moleculeId AND (SELECT isPublic FROM sources WHERE id = NEW.sourceId) = 1;
  END`,
  `CREATE TRIGGER entries_delete AFTER DELETE ON molecule_sources BEGIN
    INSERT INTO entry_changes (moleculeId) VALUES (OLD.moleculeId);
    UPDATE molecules SET listed = EXISTS (
      SELECT 1 FROM molecule_sources ms JOIN sources s ON s.id = ms.sourceId
      WHERE ms.moleculeId = OLD.moleculeId AND s.isPublic = 1)
      WHERE id = OLD.moleculeId;
  END`,
  `CREATE TRIGGER molecules_update AFTER UPDATE OF weight, logP, hba, charge ON molecules BEGIN
    INSERT INTO entry_changes (moleculeId) VALUES (NEW.id);
  END`,
  `CREATE TRIGGER molecules_delete AFTER DELETE ON molecules BEGIN
    INSERT INTO entry_changes (moleculeId) VALUES (OLD.id);
  END`,
  "INSERT INTO sources (id, name, isPublic) VALUES (1, 'A', 1), (2, 'B', 1), (3, 'P', 0)",
];

/** How the index reads the test application. */
export const SPEC: IndexSpec = {
  columns: {
    sql: 'SELECT id, weight, logP, hba, charge FROM molecules WHERE id BETWEEN :from AND :to ORDER BY id',
    filters: [
      { name: 'logP', type: 'float32' },
      { name: 'hba', type: 'int16' },
      { name: 'charge', type: 'int32' },
    ],
  },
  sets: {
    listed: {
      members:
        'SELECT id FROM molecules WHERE listed = 1 AND id BETWEEN :from AND :to ORDER BY id',
    },
    source: {
      names: 'SELECT id FROM sources',
      members:
        'SELECT moleculeId FROM molecule_sources WHERE sourceId = :set AND moleculeId BETWEEN :from AND :to ORDER BY moleculeId',
    },
  },
  defaultSets: ['listed'],
  changes: {
    read: 'SELECT id, moleculeId FROM entry_changes WHERE id > :after ORDER BY id LIMIT :limit',
    last: "SELECT seq FROM sqlite_sequence WHERE name = 'entry_changes'",
    first: 'SELECT min(id) FROM entry_changes',
  },
};

/**
 * The idCodes of the tests: `OCL_SQLITE_IDCODES` (a file, one idCode per line) when set, else
 * the committed sample of the molecules dev database.
 * @returns The idCodes.
 */
export function readIdCodes(): string[] {
  const file =
    process.env.OCL_SQLITE_IDCODES ??
    join(import.meta.dirname, 'data/molecules.txt');
  return readFileSync(file).toString('latin1').split('\n').filter(Boolean);
}

/**
 * Adds molecules to a test database through the store, with their application rows, in
 * transactions of `batch`: a deterministic key near OCL's weight (with ties and a few
 * outliers far from it), filter values (with float32 and int16 edge cases) and sources.
 * @param db - The connection.
 * @param store - The store.
 * @param idCodes - The molecules.
 * @param options - The seed, the batch size, and the sources (default: drawn).
 * @param options.seed - The seed of the drawn values.
 * @param options.batch - Molecules per transaction.
 * @param options.sources - Every molecule goes to these sources instead of drawn ones.
 * @returns The ids, per idCode (undefined for one the store refused).
 */
export async function addMolecules(
  db: DatabaseSync,
  store: MoleculeStore,
  idCodes: readonly string[],
  options: { seed?: number; batch?: number; sources?: number[] } = {},
): Promise<Array<number | undefined>> {
  const { seed = 1, batch = 500, sources } = options;
  const random = new XSadd(seed);
  const insertMolecule = db.prepare(
    'INSERT INTO molecules (id, weight, logP, hba, charge) VALUES (?, ?, ?, ?, ?)',
  );
  const insertEntry = db.prepare(
    'INSERT OR IGNORE INTO molecule_sources (sourceId, moleculeId) VALUES (?, ?)',
  );
  const ids: Array<number | undefined> = [];
  for (let from = 0; from < idCodes.length; from += batch) {
    const chunk = idCodes.slice(from, from + batch);
    // eslint-disable-next-line no-await-in-loop -- one batch per transaction, in order
    const prepared = await store.prepare(chunk);
    db.exec('BEGIN IMMEDIATE');
    const results = store.commit(prepared);
    for (const [i, result] of results.entries()) {
      ids.push(result?.id);
      if (result === undefined) continue;
      if (result.created) {
        const values = drawValues(random, chunk[i] as string);
        insertMolecule.run(result.id, ...values);
      }
      for (const sourceId of sources ?? drawSources(random)) {
        insertEntry.run(sourceId, result.id);
      }
    }
    db.exec('COMMIT');
  }
  return ids;
}

function drawValues(
  random: XSadd,
  idCode: string,
): [number, number | null, number | null, number | null] {
  const weight = OCL.Molecule.fromIDCode(idCode, false).getMolecularFormula()
    .relativeWeight;
  const draw = random.getFloat();
  let key = Math.round((weight + (random.getFloat() - 0.5) / 10) * 1000) / 1000;
  if (draw < 0.02) key = Math.max(0, weight - 50);
  else if (draw < 0.04) key = Math.round(weight);
  const pick = random.getFloat();
  const logP =
    pick < 0.03
      ? 2
      : pick < 0.06
        ? 2.0000001
        : pick < 0.08
          ? null
          : Math.round((random.getFloat() * 10 - 3) * 1e6) / 1e6;
  const hbaDraw = random.getFloat();
  const hba =
    hbaDraw < 0.02
      ? 40_000
      : hbaDraw < 0.04
        ? null
        : Math.floor(random.getFloat() * 11);
  const charge =
    random.getFloat() < 0.05 ? null : Math.floor(random.getFloat() * 5) - 2;
  return [key, logP, hba, charge];
}

function drawSources(random: XSadd): number[] {
  const sources: number[] = [];
  if (random.getFloat() < 0.7) sources.push(1);
  if (random.getFloat() < 0.2) sources.push(2);
  if (random.getFloat() < 0.15) sources.push(3);
  return sources;
}
