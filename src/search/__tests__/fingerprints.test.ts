/* eslint-disable no-await-in-loop -- each page continues the previous one */
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
import { readTruth, similarityTruth } from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SimilarityFingerprint } from '../fingerprint.ts';
import type { SearchOptions } from '../pages.ts';
import type { ScorePage, SimilarityOptions } from '../scorePage.ts';

const large = process.env.OCL_SQLITE_IDCODES !== undefined;
const TIMEOUT = large ? 3_600_000 : 120_000;
const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const QUERIES = {
  flavone: smiles('O=c1cc(-c2ccccc2)oc2ccccc12'),
  aspirin: smiles('CC(=O)Oc1ccccc1C(=O)O'),
  ethanol: smiles('CCO'),
};
const SETS: Record<string, SearchOptions> = {
  none: {},
  'source B': { sets: ['source:2'] },
  'logP >= 2.0000001 (float32 edge)': { filters: { logP: { min: 2.0000001 } } },
  'key 250-400': { keyMin: 250, keyMax: 400 },
};

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-fingerprints-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(4) });
  await addMolecules(db, store, readIdCodes(), { seed: 11 });
  rows = readTruth(db);
  index = await MoleculeIndex.open(join(directory, 'db.sqlite'), SPEC, {
    threads: testThreads(3),
    readers: testThreads(2),
    blockRows: large ? 65_536 : 512,
    follow: false,
  });
}, TIMEOUT);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Pages a similarity search to its end with its cursor.
 * @param query - The query molecule.
 * @param options - The search's options.
 * @returns The hits, and the pages.
 */
async function readScores(
  query: string,
  options: SimilarityOptions,
): Promise<{ hits: ScorePage['hits']; pages: ScorePage[] }> {
  const hits: ScorePage['hits'] = [];
  const pages: ScorePage[] = [];
  let after = options.after;
  for (;;) {
    const page = await index.similarity(query, {
      ...options,
      after,
      budgetMs: 60_000,
    });
    pages.push(page);
    hits.push(...page.hits);
    if (page.next === undefined) return { hits, pages };
    after = page.next;
  }
}

test.each<SimilarityFingerprint>(['fragFp', 'screen', 'both'])(
  'similarity on %s, at 0.8 and 0.6, paged with its cursor, equals Tanimoto brute force',
  async (fingerprint) => {
    const failures: string[] = [];
    let hitsSeen = 0;
    // Three molecules of the file too, light to heavy: each has neighbours there.
    const listed = rows.filter((row) => row.listed);
    const members = [0.25, 0.5, 0.75].map((at) => [
      `member at ${at}`,
      (listed[Math.floor(at * (listed.length - 1))] as TruthRow).idCode,
    ]);
    for (const [name, query] of [
      ...Object.entries(QUERIES),
      ...members,
    ] as Array<[string, string]>) {
      for (const threshold of [0.8, 0.6]) {
        for (const [setName, options] of Object.entries(SETS)) {
          const label = `${name}, ${setName}, t ${threshold}`;
          const expected = similarityTruth(
            rows,
            query,
            threshold,
            options,
            fingerprint,
          );
          for (const limit of [7, 1000]) {
            const { hits, pages } = await readScores(query, {
              ...options,
              threshold,
              limit,
              fingerprint,
            });
            if (JSON.stringify(hits) !== JSON.stringify(expected)) {
              failures.push(`${label}, limit ${limit}: hits differ`);
            }
            for (const page of pages) {
              if (
                page.partial ||
                page.reason !== undefined ||
                page.fingerprint !== fingerprint ||
                page.total !== expected.length ||
                (page.next !== undefined &&
                  page.next.fingerprint !== fingerprint)
              ) {
                failures.push(`${label}, limit ${limit}: page fields`);
              }
            }
          }
          hitsSeen += expected.length;
        }
      }
    }

    expect(failures).toStrictEqual([]);
    // The checks are not vacuous: they compared this many expected hits.
    expect(hitsSeen).toBeGreaterThanOrEqual(40);
  },
  TIMEOUT,
);

test("'fragFp' is the default and its scores are FragFp's own Tanimoto, as before", async () => {
  const query = QUERIES.flavone;
  const byDefault = await readScores(query, { threshold: 0.6, limit: 5 });
  const explicit = await readScores(query, {
    threshold: 0.6,
    limit: 5,
    fingerprint: 'fragFp',
  });

  expect(byDefault.hits).toStrictEqual(explicit.hits);
  expect(byDefault.hits).toStrictEqual(
    similarityTruth(rows, query, 0.6, {}, 'fragFp'),
  );
  expect(byDefault.pages[0]?.fingerprint).toBe('fragFp');
  expect(byDefault.pages[0]?.next?.fingerprint).toBe('fragFp');
});

test('a query with no bit in the fingerprint answers an empty page with a reason', async () => {
  const methane = smiles('C');
  const noFragFp = await index.similarity(methane, {
    fingerprint: 'fragFp',
    threshold: 0.5,
  });

  expect(noFragFp).toStrictEqual({
    hits: [],
    next: undefined,
    total: 0,
    partial: false,
    fingerprint: 'fragFp',
    reason:
      'The query sets no FragFp bit, so no molecule was scored. Choose the screen fingerprint, or both.',
    info: { units: 0, unitsDone: 0, scored: 0, version: index.version },
  });

  const screen = await index.similarity(methane, {
    fingerprint: 'screen',
    threshold: 0.5,
  });

  expect(screen.reason).toBeUndefined();
  expect(screen.total).toBe(
    similarityTruth(rows, methane, 0.5, {}, 'screen').length,
  );

  const emptyMolecule = await index.similarity('d@', { fingerprint: 'both' });

  expect(emptyMolecule.reason).toBe(
    'The query sets no fingerprint bit, so no molecule was scored.',
  );
  expect(emptyMolecule.hits).toStrictEqual([]);
});

test('a cursor belongs to its fingerprint: another one refuses it', async () => {
  const query = QUERIES.aspirin;
  const first = await index.similarity(query, {
    fingerprint: 'screen',
    threshold: 0.6,
    limit: 3,
  });

  expect(first.next?.fingerprint).toBe('screen');

  await expect(
    index.similarity(query, {
      fingerprint: 'fragFp',
      threshold: 0.6,
      after: first.next,
    }),
  ).rejects.toThrow(
    "this cursor belongs to the 'screen' fingerprint; the search scores 'fragFp'",
  );

  // A cursor without a fingerprint, as 6.0 before the choice wrote it, is a FragFp cursor.
  const legacy = { score: 0.7, id: 0 };
  const continued = await index.similarity(query, {
    threshold: 0.6,
    after: legacy,
  });

  expect(continued.fingerprint).toBe('fragFp');

  await expect(
    index.similarity(query, { fingerprint: 'both', after: legacy }),
  ).rejects.toThrow(
    "this cursor belongs to the 'fragFp' fingerprint; the search scores 'both'",
  );
  await expect(
    index.similarity(query, {
      fingerprint: 'tanimoto' as SimilarityFingerprint,
    }),
  ).rejects.toThrow("is 'fragFp', 'screen' or 'both'");
});
