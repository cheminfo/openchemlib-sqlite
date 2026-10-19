/* eslint-disable no-await-in-loop -- writes run one after the other, beside the rebuild */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, expect, test } from 'vitest';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import {
  readAll,
  readTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import {
  computeSignatures,
  computeStamp,
  stampOf,
} from '../../chemistry/stamp.ts';
import { FUNCTION_PLANES_AT, PLANES } from '../../chemistry/tile.ts';
import { MoleculeIndex } from '../../search/MoleculeIndex.ts';
import type { SearchOptions } from '../../search/pages.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import { readMeta } from '../schema.ts';

import { bruteCounts } from './bruteCounts.ts';
import {
  StoreFiles,
  scramblePlanes,
  setMeta,
  tables,
} from './rebuildFixtures.ts';
import { commitIds, removeIds } from './storeSteps.ts';

const idCodes = readIdCodes();
const files = new StoreFiles('ocl-sqlite-rebuild-functions-');
/** The function-key signature of another build: not digits alone, which `ocl_meta` would store as a number. */
const OTHER = 'feedfacefeedface';

afterAll(() => files.close());

/**
 * Searches on function keys: what an index answers from planes 1024-1535.
 * @param db - The database, with the test application.
 * @returns Searches with three function keys held by some molecules, as a row must hold or lack.
 */
function functionSearches(db: DatabaseSync): SearchOptions[] {
  const { functions, molecules } = bruteCounts(db);
  const counts = functions as Float64Array;
  const held: number[] = [];
  for (let key = 0; key < 512 && held.length < 3; key++) {
    const share = (counts[key] as number) / molecules;
    if (share >= 0.05 && share <= 0.5) held.push(1024 + key);
  }
  const [a = 1024, b = 1025, c = 1026] = held;
  return [
    { bits: { all: [a] } },
    { bits: { none: [b] } },
    { bits: { any: [b, c], none: [a] } },
  ];
}

test('function planes of other keys: refused, rebuilt beside the tiles in use, and an index opened afterwards answers them and follows the file', async () => {
  const file = join(files.directory, 'functions.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 30000');
  for (const sql of APP_SQL) db.exec(sql);
  const writer = await files.open(db);
  await addMolecules(db, writer, idCodes.slice(0, 300), { seed: 5 });
  const before = writer.bitCounts();
  await writer.close();
  // What a build with other function keys left: other function planes, under its signatures.
  scramblePlanes(db, FUNCTION_PLANES_AT, PLANES);
  setMeta(db, 'signature.functions', OTHER);
  setMeta(db, 'counted.functions', OTHER);
  const signatures = await computeSignatures();
  setMeta(db, 'stamp', await stampOf({ ...signatures, functions: OTHER }));

  await expect(
    MoleculeStore.open(db, { threads: testThreads(2) }),
  ).rejects.toThrow(/the functions bits .* MoleculeStore\.rebuild\(\)/);
  await expect(
    MoleculeIndex.open(file, SPEC, { threads: testThreads(1) }),
  ).rejects.toThrow(/MoleculeStore\.rebuild\(\) must bring it to this build/);
  await expect(MoleculeStore.updates(db)).resolves.toStrictEqual({
    identity: false,
    tiles: ['functions'],
    counts: ['functions'],
    idCodeHash: false,
    rebuilding: false,
  });

  const result = await MoleculeStore.rebuild(db, {
    threads: testThreads(2),
    tilesPerStep: 4,
  });

  expect(result).toStrictEqual({
    rebuilt: ['functions'],
    counted: ['functions'],
    molecules: 300,
    hashed: 0,
  });
  expect(readMeta(db)).toMatchObject({
    stamp: await computeStamp(),
    generation: 1,
    rebuild: '',
  });

  // Every molecule's 48 words recomputed against its slot: the check of the opening passes.
  const rebuilt = await files.open(db, 300);

  expect(rebuilt.bitCounts()).toStrictEqual(before);
  expect(rebuilt.bitCounts()).toStrictEqual(bruteCounts(db));

  const index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    blockRows: 512,
    pollMs: 3_600_000,
  });
  try {
    for (const step of ['rebuilt', 'followed']) {
      if (step === 'followed') {
        await addMolecules(db, rebuilt, idCodes.slice(300, 340), { seed: 6 });
        await index.poll();
      }
      const rows = readTruth(db, { keys: true });
      for (const options of functionSearches(db)) {
        const { ids } = await readAll(index, '', { ...options, limit: 1000 });

        expect(ids, `${step}: ${JSON.stringify(options)}`).toStrictEqual(
          substructureTruth(rows, '', options),
        );
      }
    }
  } finally {
    await index.close();
  }
}, 120_000);

test('commits and removals on another connection, while the function keys are rebuilt, land in the new tiles and counts', async () => {
  const { db, store: writer } = await files.storeWith(
    'concurrent',
    idCodes.slice(0, 300),
  );
  // The function planes of the file are computed under other keys: the store opened before writes on.
  scramblePlanes(db, FUNCTION_PLANES_AT, PLANES);
  setMeta(db, 'signature.functions', OTHER);
  setMeta(db, 'counted.functions', OTHER);
  const job = new DatabaseSync(join(files.directory, 'concurrent.sqlite'));
  job.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA busy_timeout = 30000');
  let logged = 0;
  const writes = (async () => {
    for (let from = 300; from < 750; from += 30) {
      if (readMeta(db).rebuild !== '') logged++;
      const ids = await commitIds(writer, db, idCodes.slice(from, from + 30));
      if (from % 90 === 0) removeIds(writer, db, ids.slice(0, 3));
    }
  })();
  const result = await MoleculeStore.rebuild(job, {
    threads: testThreads(2),
    tilesPerStep: 1,
  });
  await writes;
  job.close();

  expect(result.rebuilt).toStrictEqual(['functions']);
  expect(logged).toBeGreaterThan(0);

  // Every molecule recomputed against its slot, the counts recounted from scratch.
  const reopened = await files.open(db, 1000);

  expect(reopened.bitCounts()).toStrictEqual(bruteCounts(db));
  expect(reopened.bitCounts().molecules).toBe(readMeta(db).count);
  expect(tables(db)).toStrictEqual([
    'ocl_bits',
    'ocl_meta',
    'ocl_molecule',
    'ocl_tile',
  ]);
}, 120_000);
