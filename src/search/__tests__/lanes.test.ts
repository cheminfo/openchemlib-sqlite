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
import { readTruth, substructureTruth } from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';

/** The vanadium self-query of the watchdog test: its verification over POOR never ends. */
const V16_QUERY = 'f``@@H@]DNaGQchItTzF]GN`WQKhUtZzC]EnawQ{h@@H';
const POOR = OCL.Molecule.fromSmiles(
  `${Array.from({ length: 15 }, () => '[V]').join('.')}.CCO`,
).getIDCode();

let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-lanes-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, [...readIdCodes().slice(0, 600), POOR], {
    sources: [1],
  });
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(3),
    blockRows: 512,
    follow: false,
    // About 50 chunks for the 601 molecules.
    countChunkRows: 12,
    watchdogGraceMs: 300,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('an interactive search runs before the bulk ones waiting, and between the chunks of a bulk count', async () => {
  const finished: string[] = [];
  const counting = index.count().then((counts) => {
    finished.push('count');
    return counts;
  });
  const browsing = index.browse({ limit: 10 }).then(() => {
    finished.push('browse');
  });
  const [counts] = await Promise.all([counting, browsing]);

  expect(finished).toStrictEqual(['browse', 'count']);
  expect(counts).toMatchObject({ total: 601, complete: true });

  finished.length = 0;
  const calls: Array<Promise<unknown>> = [];
  for (let i = 0; i < 4; i++) {
    calls.push(
      index
        .browse({ limit: 5, lane: 'bulk' })
        .then(() => finished.push(`bulk ${i}`)),
    );
  }
  calls.push(index.browse({ limit: 5 }).then(() => finished.push('site')));
  await Promise.all(calls);

  // The first bulk browse was running: the site's browse came next, ahead of the three waiting.
  expect(finished).toStrictEqual([
    'bulk 0',
    'site',
    'bulk 1',
    'bulk 2',
    'bulk 3',
  ]);
}, 60_000);

test('a bulk search queued behind a slow interactive one still gets its whole budget', async () => {
  const hung = index.substructure(V16_QUERY, { limit: 24, budgetMs: 600 });
  const queued = performance.now();
  const bulk = index.browse({ limit: 1000, lane: 'bulk', budgetMs: 200 });
  const [hungPage, bulkPage] = await Promise.all([hung, bulk]);
  const expected = substructureTruth(readTruth(db), '', {});

  expect(hungPage.partial).toBe(true);
  // It waited for the hung search, longer than its own budget, and still answered whole.
  expect(performance.now() - queued).toBeGreaterThan(500);
  expect(bulkPage.partial).toBe(false);
  expect(bulkPage.hits.map((hit) => hit.id)).toStrictEqual(expected);
}, 60_000);

test('a search or a count whose signal aborts while it waits answers at once, never having run', async () => {
  const hung = index.substructure(V16_QUERY, { limit: 24, budgetMs: 800 });
  const queued = performance.now();
  const [count, page, similar] = await Promise.all([
    index.count({ signal: AbortSignal.timeout(50) }),
    index.browse({
      lane: 'bulk',
      keyMin: 100,
      signal: AbortSignal.timeout(50),
    }),
    index.similarity(OCL.Molecule.fromSmiles('c1ccccc1').getIDCode(), {
      signal: AbortSignal.timeout(50),
    }),
  ]);
  const waited = performance.now() - queued;
  await hung;

  // The hung search runs 800 ms: the three left their lanes long before.
  expect(waited).toBeLessThan(500);
  expect(count).toMatchObject({ total: 0, complete: false });
  expect(page).toMatchObject({
    hits: [],
    partial: true,
    next: { key: 100, id: -1 },
  });
  expect(similar).toMatchObject({ hits: [], partial: true, total: 0 });
}, 60_000);
