/* eslint-disable no-await-in-loop -- pages and checks run one after the other */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import {
  readAll,
  readTruth,
  similarityTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SearchOptions } from '../pages.ts';
import type { ScoreCursor } from '../walk/similarityPage.ts';

// OCL_SQLITE_IDCODES points the same checks at a larger set (the dev database, a 100 k subset).
const large = process.env.OCL_SQLITE_IDCODES !== undefined;
const TIMEOUT = large ? 3_600_000 : 120_000;
const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const QUERIES: Record<string, string> = {
  benzene: smiles('c1ccccc1'),
  pyridine: smiles('c1ccncc1'),
  phenol: smiles('Oc1ccccc1'),
  naphthalene: smiles('c1ccc2ccccc2c1'),
  'sulfonamide-aryl': smiles('NS(=O)(=O)c1ccccc1'),
  steroid: smiles('C1CCC2C(C1)CCC1C2CCC2CCCC12'),
  flavone: smiles('O=c1cc(-c2ccccc2)oc2ccccc12'),
  cubane: smiles('C12C3C4C1C5C2C3C45'),
  'wildcard-substituent': 'gOp@DjWkB@@Mi`',
  'list-halobenzene': 'gOpHMDIToVD@@]SLYlbLRl@',
  'exclude-ester': 'deTD@@QIemQej@@@O~pP',
  'any-bond-carbocycle6': 'gFp@DiTvjhCUc|~o{y_`',
  'ring-size3-acid': 'gC``@dfZ@aM`',
  'aromatic-atom-nitro': 'gCh`hEIWILtAuMVf@',
};

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];
let sets: Record<string, SearchOptions>;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-brute-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(4) });
  await addMolecules(db, store, readIdCodes(), { seed: 7 });
  rows = readTruth(db);
  // The key most rows share (rounded keys make ties): a seek to one exact key.
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  let tied = 0;
  let most = 0;
  for (const [key, count] of counts) {
    if (count > most) {
      most = count;
      tied = key;
    }
  }
  sets = {
    none: {},
    'key 250-400': { keyMin: 250, keyMax: 400 },
    'key >= 250.5': { keyMin: 250.5 },
    'key = the most shared key': { keyMin: tied, keyMax: tied },
    'logP >= 2.0000001 (float32 edge)': {
      filters: { logP: { min: 2.0000001 } },
    },
    'logP <= 2 (float32 edge)': { filters: { logP: { max: 2 } } },
    'hba <= 3, charge 0-1': {
      filters: { hba: { max: 3 }, charge: { min: 0, max: 1 } },
    },
    'hba >= 35000 (int16 saturated)': { filters: { hba: { min: 35_000 } } },
    'source B': { sets: ['source:2'] },
    'sources A and P (private)': { sets: ['source:1', 'source:3'] },
    'private P only': { sets: ['source:3'] },
    'unknown set': { sets: ['source:99'] },
  };
  index = await MoleculeIndex.open(join(directory, 'db.sqlite'), SPEC, {
    threads: testThreads(3),
    readers: testThreads(2),
    blockRows: large ? 65_536 : 512,
    firstSliceRows: large ? 4096 : 64,
    follow: false,
  });
}, TIMEOUT);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('the index loads every molecule of the file', () => {
  expect(index.rowCount).toBe(store.count());
  expect(index.sets.toSorted()).toStrictEqual([
    'listed',
    'source:1',
    'source:2',
    'source:3',
  ]);
});

test.each([...Object.keys(QUERIES), 'browse'])(
  '%s: complete answers, first pages and tight-budget pages equal brute force, in (key, id) order',
  async (name) => {
    const query = name === 'browse' ? '' : (QUERIES[name] as string);
    for (const [setName, options] of Object.entries(sets)) {
      const expected = substructureTruth(rows, query, options);
      const full = await readAll(index, query, { ...options, limit: 1000 });

      expect(full.ids, `${setName}, limit 1000`).toStrictEqual(expected);
      expect(full.exhausted).toBe(true);

      const first = await readAll(index, query, { ...options, limit: 24 }, 5);

      expect(first.ids, `${setName}, 5 pages of 24`).toStrictEqual(
        expected.slice(0, 120),
      );

      const small = await readAll(index, query, { ...options, limit: 7 }, 100);

      expect(small.ids, `${setName}, pages of 7`).toStrictEqual(
        expected.slice(0, 700),
      );

      const tight = await readAll(index, query, {
        ...options,
        limit: 50,
        budgetMs: 2,
      });

      expect(tight.ids, `${setName}, 2 ms pages`).toStrictEqual(expected);
    }
  },
  TIMEOUT,
);

test.each([
  ['flavone', 'O=c1cc(-c2ccccc2)oc2ccccc12'],
  ['aspirin', 'CC(=O)Oc1ccccc1C(=O)O'],
  ['naphthalene', 'c1ccc2ccccc2c1'],
])(
  'similarity to %s, paged with the (score, id) cursor, equals Tanimoto brute force',
  async (_name, text) => {
    const query = smiles(text);
    for (const threshold of [0.5, 0.8]) {
      for (const setName of [
        'none',
        'source B',
        'logP >= 2.0000001 (float32 edge)',
        'key 250-400',
      ]) {
        const options = sets[setName] as SearchOptions;
        const expected = similarityTruth(rows, query, threshold, options);
        for (const limit of [24, 7]) {
          const hits: Array<{ id: number; score: number }> = [];
          let after: ScoreCursor | undefined;
          for (;;) {
            const page = await index.similarity(query, {
              ...options,
              threshold,
              limit,
              after,
              budgetMs: 60_000,
            });

            expect(page.partial).toBe(false);
            expect(page.total).toBe(expected.length);

            hits.push(...page.hits);
            if (page.next === undefined) break;
            after = page.next;
          }

          expect(
            hits,
            `${setName}, t ${threshold}, limit ${limit}`,
          ).toStrictEqual(expected);
        }
      }
    }
  },
  TIMEOUT,
);
