import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import type { MoleculesDBConfig } from '../../types.ts';
import type { PrescreenState } from '../../utils/prescreen.ts';
import { prescreen } from '../../utils/prescreen.ts';

/**
 * An empty, migrated library whose router takes the plane path whenever it can.
 * @param config - Settings to change.
 * @returns The connection and the molecules DB.
 */
export function emptyLibrary(config: Partial<MoleculesDBConfig> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    searchCacheSize: 0,
    planeCandidateRatio: 1,
    ...config,
  });
  molDB.migrate();
  return { db, molDB };
}

/** The molecules {@link foldedLibrary} holds, as entries 10, 20 … 80. */
export const SPACED_SMILES = [
  'Oc1ccccc1',
  'Cc1ccccc1',
  'O=C(N)c1ccccc1',
  'NS(=O)(=O)c1ccccc1',
  'CCO',
  'C1CCCCC1',
  'Oc1ccc(Cl)cc1',
  'CC(=O)Oc1ccccc1C(=O)O',
];

/**
 * Entries 10, 20 … 80, folded with every plane stored so the plane index
 * answers any fragment, and room between the ids for out-of-order ones.
 * @returns The connection and the molecules DB.
 */
export function foldedLibrary() {
  const library = emptyLibrary();
  for (const [index, smiles] of SPACED_SMILES.entries()) {
    add(library.db, library.molDB, smiles, 10 * (index + 1));
  }
  library.molDB.foldPlanes({ maxPopulationRatio: 1 });
  return library;
}

/**
 * How many slots stand for an entry.
 * @param db - The connection.
 * @param entryId - The entry.
 * @returns 0 or 1.
 */
export function slotsOf(db: DatabaseSync, entryId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM ocl_ss_slot WHERE entry_id = ?')
    .get(entryId) as Record<string, unknown>;
  return Number(row.n);
}

/**
 * Write a molecule to the entries table and the index, or write it again.
 * @param db - The connection.
 * @param molDB - The molecules DB.
 * @param smiles - The molecule.
 * @param id - The id to give it; the next one when omitted.
 * @returns The entry id.
 */
export function add(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  smiles: string,
  id?: number,
): number {
  const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
  const { lastInsertRowid } =
    id === undefined
      ? db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(idCode)
      : db
          .prepare(
            'INSERT OR REPLACE INTO molecules (id, id_code) VALUES (?, ?)',
          )
          .run(id, idCode);
  molDB.insert(Number(lastInsertRowid), idCode);
  return Number(lastInsertRowid);
}

/**
 * The candidates the prescreen yields for a fragment.
 * @param db - The connection.
 * @param smiles - The fragment.
 * @param planeIndex - Whether the plane index may answer.
 * @returns The candidate ids, ascending with any repeat kept, and the path.
 */
export function screen(db: DatabaseSync, smiles: string, planeIndex = true) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  const state: PrescreenState = { screened: 0, partial: false };
  const found = [
    ...prescreen(
      {
        db,
        entriesTable: 'molecules',
        pkColumn: 'id',
        idCodeColumn: 'id_code',
        mol,
        timeoutMs: 60_000,
        maxCandidates: Number.MAX_SAFE_INTEGER,
        planeCandidateRatio: 1,
        planeIndex,
      },
      state,
    ),
  ];
  return {
    ids: found.map((c) => c.entryId).toSorted((a, b) => a - b),
    usedPlaneIndex: state.usedPlaneIndex === true,
  };
}

/**
 * Assert the plane path answers a fragment, and exactly as the column path does.
 * @param db - The connection.
 * @param smiles - The fragment.
 * @returns The candidate ids, ascending.
 */
export function expectSameAsColumn(db: DatabaseSync, smiles: string): number[] {
  const planes = screen(db, smiles);

  expect(planes.usedPlaneIndex).toBe(true);
  expect(planes.ids).toStrictEqual(screen(db, smiles, false).ids);

  return planes.ids;
}

/**
 * Everything the plane index holds, so a test can assert it did not change.
 * @param db - The connection.
 * @returns Every row of the plane tables and of the fold state, as JSON.
 */
export function planeSnapshot(db: DatabaseSync): string {
  const tables = [
    'ocl_ss_plane',
    'ocl_ss_slot',
    'ocl_ss_segment',
    'ocl_ss_bitstat',
    'ocl_ss_fold',
  ];
  return JSON.stringify(
    tables.map((table) =>
      db
        .prepare(`SELECT * FROM ${table} ORDER BY 1, 2`)
        .all()
        .map((row) => ({ ...row })),
    ),
    (_key, value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value,
  );
}

const CORES = [
  'c1ccc(*)cc1*',
  'c1cc(*)ncc1*',
  'C1CC(*)CCN1*',
  'c1cc2cc(*)ccc2cc1*',
  'O=C(N*)c1ccc(*)cc1',
  'c1nc(*)sc1*',
  'C1CCC(*)C(*)C1',
  'c1ccc2c(c1)[nH]c(*)c2*',
  'OC(=O)C(*)C*',
  'c1cn(*)c(*)n1',
];

const GROUPS = [
  '[H]',
  'C',
  'CC',
  'C(C)C',
  'O',
  'OC',
  'N',
  'N(C)C',
  'F',
  'Cl',
  'Br',
  'C(F)(F)F',
  'C#N',
  'C(=O)O',
  'C(=O)N',
  'C(=O)OC',
  'S(=O)(=O)N',
  'NC(=O)C',
  'c9ccccc9',
  'C9CCCCC9',
  'N9CCOCC9',
  'N9CCNCC9',
  'c9ccncc9',
  'OCCO',
  'CC(=O)C',
  '[N+](=O)[O-]',
  'SC',
  'C=C',
  'c9ccco9',
  'P(=O)(O)O',
];

/**
 * A combinatorial library: ten cores, each with two substituents from thirty,
 * as distinct idCodes in a fixed order.
 * @param count - How many to return.
 * @returns The idCodes.
 */
export function generatedLibrary(count: number): string[] {
  const seen = new Set<string>();
  const idCodes: string[] = [];
  for (const second of GROUPS) {
    for (const first of GROUPS) {
      for (const core of CORES) {
        const smiles = core.replace('*', first).replace('*', second);
        const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
        if (seen.has(idCode)) continue;
        seen.add(idCode);
        idCodes.push(idCode);
        if (idCodes.length === count) return idCodes;
      }
    }
  }
  return idCodes;
}
