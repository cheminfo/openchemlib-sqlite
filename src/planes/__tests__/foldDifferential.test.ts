import type { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { getIndex } from 'openchemlib-search-wasm';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import type { SearchOptions } from '../../types.ts';
import { readFoldState } from '../foldState.ts';

import {
  emptyLibrary,
  generatedLibrary,
  planeSnapshot,
  screen,
} from './fixture.ts';

const LIBRARY = generatedLibrary(3200).map((idCode) => ({
  idCode,
  index: getIndex(idCode),
  mw: OCL.Molecule.fromIDCode(idCode, false).getMolecularFormula()
    .relativeWeight,
}));

const FRAGMENTS = [
  'c1ccccc1',
  'Oc1ccccc1',
  'C(F)(F)F',
  'NS(=O)=O',
  'c1ccoc1',
  'OP(O)=O',
  'c1ccc2ccccc2c1',
  'C1COCCN1',
  'N#Cc1ccccc1',
  'c1ccncc1',
  'c1cscn1',
  'c1ccc2[nH]ccc2c1',
  'CC(C)=O',
  'C1CCNCC1',
];

const VARIANTS: SearchOptions[] = [
  {},
  { maxResults: 25 },
  {
    candidates: {
      sql: 'SELECT id AS entry_id FROM molecules WHERE id % 3 = 0',
    },
  },
  { mwRange: { min: 200, max: 320 } },
];

/**
 * Two libraries given the same writes: one folded along the way, one never.
 * @returns Both, and the writes that go to both.
 */
function pair() {
  const folded = emptyLibrary();
  const plain = emptyLibrary();
  const both = [folded, plain];
  return {
    folded,
    plain,
    write(id: number, molecule: number) {
      const entry = LIBRARY[molecule] as (typeof LIBRARY)[number];
      for (const { db, molDB } of both) {
        db.prepare(
          'INSERT OR REPLACE INTO molecules (id, id_code) VALUES (?, ?)',
        ).run(id, entry.idCode);
        molDB.insert(id, entry.idCode, { index: entry.index, mw: entry.mw });
      }
    },
    remove(id: number) {
      for (const { db, molDB } of both) {
        molDB.remove(id);
        db.prepare('DELETE FROM molecules WHERE id = ?').run(id);
      }
    },
    async backfill() {
      await Promise.all(
        both.map(({ molDB }) => molDB.backfillHashes({ poolSize: 1 })),
      );
    },
  };
}

/**
 * Every answer a library gives: each mode, the substructure search under each
 * restriction, as ids in the order they come back.
 * @param molDB - The library to ask.
 * @returns One line per query.
 */
async function answers(molDB: MoleculesDBSQLite): Promise<string[]> {
  const queries: Array<[string, SearchOptions]> = [];
  for (const fragment of FRAGMENTS) {
    for (const variant of VARIANTS) {
      queries.push([fragment, { mode: 'substructure', ...variant }]);
    }
  }
  for (const entry of [LIBRARY[7], LIBRARY[1500], LIBRARY[3100]]) {
    const idCode = entry?.idCode ?? '';
    for (const mode of [
      'exact',
      'exactNoStereo',
      'exactNoStereoTautomer',
    ] as const) {
      queries.push([idCode, { mode, format: 'idCode' }]);
    }
    for (const similarityThreshold of [0.6, 0.85]) {
      queries.push([
        idCode,
        { mode: 'similarity', format: 'idCode', similarityThreshold },
      ]);
    }
  }
  return Promise.all(
    queries.map(async ([query, options]) => {
      const response = await molDB.search(query, {
        timeoutMs: 600_000,
        ...options,
      });
      const ids = response.results.map((result) => result.entryId);
      return `${query} ${JSON.stringify(options)} ${response.total} ${ids.join(',')}`;
    }),
  );
}

/**
 * Assert both libraries answer every query identically, the folded one through
 * the plane index for the fragments listed.
 * @param libraries - The pair.
 * @param planeFragments - The fragments the folded one screens on its planes.
 */
async function expectSameAnswers(
  libraries: ReturnType<typeof pair>,
  planeFragments: string[],
) {
  const { folded, plain } = libraries;

  await expect(answers(folded.molDB)).resolves.toStrictEqual(
    await answers(plain.molDB),
  );
  expect(throughPlanes(folded.db)).toStrictEqual(planeFragments);
}

/**
 * The fragments the router sends to the plane index.
 * @param db - The connection.
 * @returns Them, in the order of {@link FRAGMENTS}.
 */
function throughPlanes(db: DatabaseSync): string[] {
  return FRAGMENTS.filter((fragment) => screen(db, fragment).usedPlaneIndex);
}

test('a search gives the same answers before and after folds, whatever is written in between', async () => {
  const libraries = pair();
  const { folded, plain } = libraries;
  // Even ids, so there is room below the watermark for out-of-order ones.
  for (let index = 0; index < 2400; index++) {
    libraries.write(2 * (index + 1), index);
  }
  await libraries.backfill();
  await expectSameAnswers(libraries, []);

  folded.molDB.foldPlanes();
  const planeFragments = throughPlanes(folded.db);

  // Benzene is the one fragment none of whose bits is rare enough to screen on.
  expect(planeFragments).toStrictEqual(FRAGMENTS.slice(1));

  await expectSameAnswers(libraries, planeFragments);

  // Increasing ids above the watermark leave the planes as they are.
  const before = planeSnapshot(folded.db);
  for (let index = 2400; index < 2600; index++) {
    libraries.write(2 * (index + 1), index);
  }

  expect(planeSnapshot(folded.db)).toBe(before);

  await libraries.backfill();
  await expectSameAnswers(libraries, planeFragments);

  // Odd ids below the watermark, entries written again with another
  // fingerprint, the same one, and removals.
  for (let index = 2600; index < 2700; index++) {
    libraries.write(4001 + 2 * (index - 2600), index);
  }
  for (let id = 4400; id < 4440; id += 2) {
    libraries.write(id, id - 2000);
  }
  libraries.write(4500, 2249);
  for (let id = 4600; id < 4700; id += 4) libraries.remove(id);
  await libraries.backfill();

  expect(readFoldState(folded.db).watermark).toBe(4000);

  await expectSameAnswers(libraries, planeFragments);

  folded.molDB.foldPlanes();

  expect(readFoldState(folded.db).watermark).toBe(5200);

  await expectSameAnswers(libraries, planeFragments);

  // Far below the watermark: too much is left above it for the planes to pay.
  libraries.write(1, 3100);
  await libraries.backfill();

  expect(readFoldState(folded.db).watermark).toBe(0);

  await expectSameAnswers(libraries, []);

  folded.molDB.foldPlanes();
  await expectSameAnswers(libraries, planeFragments);

  folded.molDB.foldPlanes({ rebuild: true });

  expect(folded.molDB.planeStatus()).toStrictEqual({
    folded: folded.molDB.count(),
    segments: 1,
    watermark: 5200,
    pending: 0,
    refoldAdvisable: false,
  });

  await expectSameAnswers(libraries, planeFragments);

  // The verifier pool answers the same through the planes as on the thread.
  const pooled = new MoleculesDBSQLite(folded.db, OCL, {
    entriesTable: 'molecules',
    poolSize: 2,
    batchSize: 16,
    searchCacheSize: 0,
    planeCandidateRatio: 1,
  });

  await expect(answers(pooled)).resolves.toStrictEqual(
    await answers(plain.molDB),
  );

  await pooled.close();
}, 120_000);
