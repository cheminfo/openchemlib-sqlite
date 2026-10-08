import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { beforeAll, expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import type { ScanPosition } from '../../types.ts';
import { prescreen } from '../../utils/prescreen.ts';
import { prescreenColumn } from '../../utils/prescreenColumn.ts';
import type {
  PrescreenParams,
  PrescreenState,
} from '../../utils/prescreenTypes.ts';
import { planeChunks, planeQueryBits } from '../planeCoverage.ts';
import { collectSurvivors } from '../planeSurvivors.ts';
import { prescreenPlanesSorted } from '../sortedPrescreen.ts';

import { generatedLibrary } from './fixture.ts';

const IDCODES = generatedLibrary(3000);

// Built once: the tests that use them only read them.
let folded: ReturnType<typeof library>;
let plain: ReturnType<typeof library>;
let large: ReturnType<typeof library>;

beforeAll(() => {
  folded = library(1500, true);
  plain = library(1500, false);
  large = library(3000, false);
}, 60_000);

/**
 * A library of generated molecules, entries 1 … count.
 * @param count - How many entries.
 * @param fold - Whether to fold them, every plane stored.
 * @returns The connection and the molecules DB.
 */
function library(count: number, fold: boolean) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    searchCacheSize: 0,
  });
  molDB.migrate();
  append(db, molDB, 0, count);
  if (fold) molDB.foldPlanes({ maxPopulationRatio: 1 });
  return { db, molDB };
}

/**
 * Add the generated molecules from one position to another.
 * @param db - The connection.
 * @param molDB - The molecules DB.
 * @param from - The first position, inclusive.
 * @param to - The last position, exclusive.
 */
function append(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  from: number,
  to: number,
): void {
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code) VALUES (?, ?)',
  );
  for (let index = from; index < to; index++) {
    const idCode = IDCODES[index] as string;
    insert.run(index + 1, idCode);
    molDB.insert(index + 1, idCode);
  }
}

/**
 * The parameters of a scan of a fragment.
 * @param db - The connection.
 * @param smiles - The fragment.
 * @param extra - What to change.
 * @returns The parameters.
 */
function scanOf(
  db: DatabaseSync,
  smiles: string,
  extra: Partial<PrescreenParams> = {},
): PrescreenParams {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  return {
    db,
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
    timeoutMs: 60_000,
    maxCandidates: Number.MAX_SAFE_INTEGER,
    planeCandidateRatio: 1,
    mwIsMolecularWeight: true,
    ...extra,
  };
}

/**
 * Every candidate a prescreen yields, in the order it yields them.
 * @param params - The scan.
 * @returns The ids, and how the scan went.
 */
function candidates(params: PrescreenParams) {
  const state: PrescreenState = { screened: 0, partial: false };
  const ids = [...prescreen(params, state)].map((c) => c.entryId);
  return { ids, state };
}

const FRAGMENTS = [
  'c1ccncc1',
  'O=C(N)c1ccccc1',
  'C1CCNCC1',
  'FC(F)(F)c1ccccc1',
  'c1ccc2[nH]ccc2c1',
];

test('a switched scan yields every candidate of the column scan, in its order', () => {
  for (const smiles of FRAGMENTS) {
    for (const maxResults of [5, 50]) {
      const switched = candidates(
        scanOf(folded.db, smiles, { maxResults, planeCheckpointMs: -1 }),
      );
      const column = candidates(scanOf(plain.db, smiles, { maxResults }));

      expect(switched.ids).toStrictEqual(column.ids);
      expect(switched.state.switchedToPlanes).toBe(true);
      expect(switched.state.usedPlaneIndex).toBeUndefined();
    }
  }
});

test('the planes of two folds and the entries above the watermark merge in order', () => {
  const twice = library(1000, true);
  append(twice.db, twice.molDB, 1000, 1400);
  twice.molDB.foldPlanes({ maxPopulationRatio: 1 });
  append(twice.db, twice.molDB, 1400, 1500);

  expect(twice.molDB.planeStatus()).toStrictEqual({
    folded: 1400,
    segments: 2,
    watermark: 1400,
    pending: 100,
    refoldAdvisable: false,
  });

  for (const smiles of FRAGMENTS) {
    const switched = candidates(
      scanOf(twice.db, smiles, { maxResults: 10, planeCheckpointMs: -1 }),
    );

    expect(switched.ids).toStrictEqual(
      candidates(scanOf(plain.db, smiles)).ids,
    );
    expect(switched.state.switchedToPlanes).toBe(true);
  }
}, 30_000);

test('a column scan stopped at its checkpoint resumes without a gap or a repeat', () => {
  const { db } = large;
  for (const smiles of ['c1ccncc1', 'FC(F)(F)c1ccccc1', 'C1CCNCC1']) {
    const whole = candidates(scanOf(db, smiles, { planeIndex: false })).ids;
    const stopped: PrescreenState = { screened: 0, partial: false };
    const before = [
      ...prescreenColumn(scanOf(db, smiles), stopped, { checkpoint: 0 }),
    ].map((c) => c.entryId);
    const after = stopped.checkpoint as ScanPosition;
    const resumed = [
      ...prescreenColumn(scanOf(db, smiles, { after }), {
        screened: 0,
        partial: false,
      }),
    ].map((c) => c.entryId);

    expect(stopped.partial).toBe(false);
    expect(before.length).toBeLessThanOrEqual(1);
    expect([...before, ...resumed]).toStrictEqual(whole);
  }
});

test('the guard records the row it stopped a scan at', () => {
  const { db } = large;
  // Dibenzoselenophene: no generated molecule holds selenium, so the scan
  // yields nothing and only the guard, at ids 1024, 2048, 3072, sees the clock.
  const state: PrescreenState = { screened: 0, partial: false };
  const yielded = [
    ...prescreenColumn(
      scanOf(db, 'c1ccc2c(c1)[se]c1ccccc12', { mwIsMolecularWeight: false }),
      state,
      { checkpoint: 0 },
    ),
  ];
  // The first row, in the scan's order, whose id the guard reads the clock at.
  const first = db
    .prepare(
      `SELECT entry_id AS id, mw FROM ocl_ss_index
        WHERE entry_id IN (1024, 2048, 3072) ORDER BY mw, entry_id LIMIT 1`,
    )
    .get() as { id: number; mw: number };

  expect(yielded).toStrictEqual([]);
  expect(state.partial).toBe(false);
  // Resumed just before that row, which the guard stopped before testing.
  expect(state.checkpoint).toStrictEqual({
    mw: first.mw,
    entryId: first.id - 1,
  });
});

test('the plane side of a switch out of time says so and yields nothing', () => {
  const { db } = library(500, true);
  const params = scanOf(db, 'c1ccncc1', { timeoutMs: -1 });
  const bits = planeQueryBits(db, params.mol.getIndex()) as number[];
  const { slots } = collectSurvivors(db, bits, planeChunks(db));
  const state: PrescreenState = { screened: 0, partial: false };
  const yielded = [
    ...prescreenPlanesSorted(params, state, {
      slots,
      watermark: 500,
      position: { mw: 0, entryId: 0 },
    }),
  ];

  expect(slots.length).toBeGreaterThan(0);
  expect(yielded).toStrictEqual([]);
  expect([state.partial, state.timedOut, state.switchedToPlanes]).toStrictEqual(
    [true, true, true],
  );
});

test('collecting survivors stops once they pass the limit', () => {
  const { db } = folded;
  const mol = OCL.Molecule.fromSmiles('c1ccncc1');
  mol.setFragment(true);
  const bits = planeQueryBits(db, mol.getIndex()) as number[];
  const chunks = planeChunks(db);
  const all = collectSurvivors(db, bits, chunks);
  const column = candidates(scanOf(db, 'c1ccncc1', { planeIndex: false }));

  // A superset of the candidates: the planes screen, the exact test decides.
  expect(all.exceeded).toBe(false);
  expect(all.count).toBe(all.slots.length);
  expect(all.count).toBeGreaterThanOrEqual(column.ids.length);
  expect(collectSurvivors(db, bits, chunks, all.count)).toStrictEqual(all);
  expect(collectSurvivors(db, bits, chunks, all.count - 1)).toStrictEqual({
    slots: new Uint32Array(0),
    count: all.count,
    exceeded: true,
  });
});
