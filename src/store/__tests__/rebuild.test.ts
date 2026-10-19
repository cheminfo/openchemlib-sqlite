/* eslint-disable no-await-in-loop -- each store is set up, written and checked in order */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { strongHash } from 'openchemlib-search-wasm';
import { afterAll, expect, test } from 'vitest';

import { readIdCodes, testThreads } from '../../__tests__/testDatabase.ts';
import { makeId, seqOf } from '../../chemistry/key.ts';
import {
  FORMAT,
  computeSignatures,
  computeStamp,
  stampOf,
} from '../../chemistry/stamp.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import { readMeta } from '../schema.ts';

import { bruteCounts } from './bruteCounts.ts';
import {
  StoreFiles,
  dropIdCodeHashes,
  idsOf,
  refusal,
  scramblePlanes,
  setMeta,
  tables,
} from './rebuildFixtures.ts';
import { commitIds, removeIds } from './storeSteps.ts';

const idCodes = readIdCodes();
const files = new StoreFiles('ocl-sqlite-rebuild-');

afterAll(() => files.close());

test('the idCode hashes of a file lacking them: rebuild() adds the column and its index, and hashes what an older build commits meanwhile', async () => {
  const { db, store } = await files.storeWith('hashes', idCodes.slice(0, 120));
  const keto = store.keys(idsOf(db)).values().next().value as {
    idCode: string;
  };
  await store.close();
  dropIdCodeHashes(db);
  setMeta(db, 'signature.idCodeHash', '');
  setMeta(
    db,
    'stamp',
    await stampOf({ ...(await computeSignatures()), idCodeHash: '' }),
  );

  await expect(MoleculeStore.updates(db)).resolves.toStrictEqual({
    identity: false,
    tiles: [],
    counts: [],
    idCodeHash: true,
    rebuilding: false,
  });

  // A build without the column commits during the pass: its row gets the default, 0.
  const late = makeId(10, readMeta(db).seq + 1);
  const result = await MoleculeStore.rebuild(db, {
    threads: testThreads(2),
    onProgress: () => {
      if (readMeta(db).seq >= seqOf(late)) return;
      db.prepare(
        'INSERT INTO ocl_molecule (id, noStereoHash, tautomerHash, idCode) VALUES (?, 1, 1, ?)',
      ).run(late, keto.idCode);
      setMeta(db, 'seq', seqOf(late));
    },
  });

  expect(result).toStrictEqual({
    rebuilt: [],
    counted: [],
    molecules: 0,
    hashed: 121,
  });

  const stored = db.prepare('SELECT idCodeHash FROM ocl_molecule WHERE id = ?');
  stored.setReadBigInts(true);

  expect((stored.get(late) as { idCodeHash: bigint }).idCodeHash).toBe(
    strongHash(keto.idCode),
  );
  expect(
    (
      db
        .prepare('SELECT count(*) AS n FROM ocl_molecule WHERE idCodeHash = 0')
        .get() as { n: number }
    ).n,
  ).toBe(0);
  expect(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ocl_molecule_idcode'",
        )
        .get() as { sql: string }
    ).sql,
  ).toBe('CREATE INDEX ocl_molecule_idcode ON ocl_molecule (idCodeHash)');
  expect(readMeta(db).stamp).toBe(await computeStamp());

  db.prepare('DELETE FROM ocl_molecule WHERE id = ?').run(late);
  const reopened = await files.open(db, 120);
  const [first] = idsOf(db);

  expect(
    reopened.byHashes('idCode', [
      reopened.keys([first as number]).get(first as number)
        ?.idCodeHash as bigint,
    ]),
  ).toStrictEqual([[first]]);
});

test('tiles holding another screen: the build refuses the file, and rebuild() computes them again beside them', async () => {
  const { db, store } = await files.storeWith('screen', idCodes.slice(0, 300));
  const before = store.bitCounts();
  await store.close();
  // What a build with other screen keys left: other screen planes, under its signature and stamp.
  scramblePlanes(db, 512, 1024);
  setMeta(db, 'signature.screen', '0000000000000000');
  setMeta(db, 'counted.screen', '0000000000000000');
  setMeta(db, 'stamp', `${FORMAT}:0000000000000000`);

  await expect(
    MoleculeStore.open(db, { threads: testThreads(2) }),
  ).rejects.toThrow(/the screen bits .* MoleculeStore\.rebuild\(\)/);
  await expect(MoleculeStore.updates(db)).resolves.toStrictEqual({
    identity: false,
    tiles: ['screen'],
    counts: ['screen'],
    idCodeHash: false,
    rebuilding: false,
  });

  const result = await MoleculeStore.rebuild(db, {
    threads: testThreads(2),
    tilesPerStep: 4,
  });

  expect(result).toStrictEqual({
    rebuilt: ['screen'],
    counted: ['screen'],
    molecules: 300,
    hashed: 0,
  });

  // Every molecule recomputed against its slot: the check of the opening passes.
  const rebuilt = await files.open(db, 300);

  expect(rebuilt.bitCounts()).toStrictEqual(before);
  expect(readMeta(db)).toMatchObject({
    stamp: await computeStamp(),
    generation: 1,
    rebuild: '',
  });
  expect(tables(db)).toStrictEqual([
    'ocl_bits',
    'ocl_meta',
    'ocl_molecule',
    'ocl_tile',
  ]);
});

test('writes go on while a rebuild is stopped, logged for it; abandoned, it leaves nothing behind', async () => {
  const { db, store } = await files.storeWith('paused', idCodes.slice(0, 200));
  await store.close();
  // Function bits counted under other keys.
  setMeta(db, 'counted.functions', '0000000000000000');
  const writer = await files.open(db);

  expect(writer.bitCounts().functions).toBeNull();

  const controller = new AbortController();
  let first = 0;

  await expect(
    MoleculeStore.rebuild(db, {
      threads: testThreads(2),
      tilesPerStep: 2,
      signal: controller.signal,
      onProgress: (progress) => {
        first = progress.molecules;
        controller.abort();
      },
    }),
  ).rejects.toThrow(/abort/i);

  await expect(MoleculeStore.updates(db)).resolves.toMatchObject({
    rebuilding: true,
  });

  const old = idsOf(db).slice(0, 5);
  const added = await commitIds(writer, db, idCodes.slice(200, 260));
  removeIds(writer, db, [...added.slice(0, 5), ...old]);
  const resumed = await MoleculeStore.rebuild(db, {
    threads: testThreads(2),
  });

  expect(first).toBeGreaterThan(0);
  expect(resumed.counted).toStrictEqual(['functions']);
  expect(writer.bitCounts()).toStrictEqual(bruteCounts(db));
  expect(writer.bitCounts().molecules).toBe(250);

  // A store of the same build takes the rebuilt file as it is, and keeps its counts.
  await commitIds(writer, db, idCodes.slice(260, 280));

  expect(writer.bitCounts()).toStrictEqual(bruteCounts(db));

  // Abandoned: the writes stop logging, the counts stay as they were, nothing built is left.
  setMeta(db, 'counted.screen', '0000000000000000');
  db.prepare(
    "UPDATE ocl_meta SET value = value + 1 WHERE name = 'generation'",
  ).run();
  const again = new AbortController();

  await expect(
    MoleculeStore.rebuild(db, {
      threads: testThreads(2),
      tilesPerStep: 1,
      signal: again.signal,
      onProgress: () => again.abort(),
    }),
  ).rejects.toThrow(/abort/i);

  await MoleculeStore.abandonRebuild(db);
  await commitIds(writer, db, idCodes.slice(280, 290));

  expect(writer.bitCounts().screen).toBeNull();
  expect(writer.bitCounts().functions).toStrictEqual(bruteCounts(db).functions);
  expect(tables(db)).toStrictEqual([
    'ocl_bits',
    'ocl_meta',
    'ocl_molecule',
    'ocl_tile',
  ]);
});

test('commits and removals on another connection, while the screen is rebuilt, land in the new tiles and counts', async () => {
  const { db, store: writer } = await files.storeWith(
    'concurrent',
    idCodes.slice(0, 600),
  );
  // The screen of the file is computed under other keys: the store opened before keeps writing.
  scramblePlanes(db, 512, 1024);
  setMeta(db, 'signature.screen', '0000000000000000');
  setMeta(db, 'counted.screen', '0000000000000000');
  const job = new DatabaseSync(join(files.directory, 'concurrent.sqlite'));
  job.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA busy_timeout = 30000');
  let logged = 0;
  const writes = (async () => {
    for (let from = 600; from < 1500; from += 60) {
      if (readMeta(db).rebuild !== '') logged++;
      const ids = await commitIds(writer, db, idCodes.slice(from, from + 60));
      if (from % 180 === 0) removeIds(writer, db, ids.slice(0, 3));
    }
  })();
  const result = await MoleculeStore.rebuild(job, {
    threads: testThreads(2),
    tilesPerStep: 1,
  });
  await writes;
  job.close();

  expect(result.rebuilt).toStrictEqual(['screen']);
  expect(logged).toBeGreaterThan(0);

  // Every molecule recomputed against its slot, the counts recounted from scratch.
  const reopened = await files.open(db, 2000);

  expect(reopened.bitCounts()).toStrictEqual(bruteCounts(db));
  expect(reopened.bitCounts().molecules).toBe(readMeta(db).count);
  expect(tables(db)).toStrictEqual([
    'ocl_bits',
    'ocl_meta',
    'ocl_molecule',
    'ocl_tile',
  ]);
});

test('a store opened before a rebuild for another build writes nothing', async () => {
  const { db, store } = await files.storeWith('foreign', idCodes.slice(0, 50));
  setMeta(db, 'stamp', `${FORMAT}:0123456789abcdef`);
  db.prepare(
    "UPDATE ocl_meta SET value = value + 1 WHERE name = 'generation'",
  ).run();

  await expect(refusal(store, db, idCodes.slice(50, 60))).resolves.toMatch(
    /rebuilt for another build/,
  );
});
