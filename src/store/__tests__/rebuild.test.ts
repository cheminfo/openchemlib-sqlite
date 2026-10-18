/* eslint-disable no-await-in-loop -- each store is set up, written and checked in order */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { strongHash } from 'openchemlib-search-wasm';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { readIdCodes, testThreads } from '../../__tests__/testDatabase.ts';
import { makeId, seqOf } from '../../chemistry/key.ts';
import {
  FORMAT,
  computeLegacyStamp,
  computeSignatures,
  computeStamp,
  stampOf,
} from '../../chemistry/stamp.ts';
import { tileViews } from '../../chemistry/tile.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import { readMeta } from '../schema.ts';

import { bruteCounts } from './bruteCounts.ts';
import { commitIds, commitSteps, removeIds } from './storeSteps.ts';

const idCodes = readIdCodes();
let directory: string;
const opened: Array<{ db: DatabaseSync; store: MoleculeStore }> = [];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-rebuild-'));
});

afterAll(async () => {
  for (const { store } of opened) await store.close();
  for (const db of new Set(opened.map((entry) => entry.db))) db.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A store in a file of its own, holding molecules.
 * @param name - The file's name.
 * @param molecules - The idCodes to commit.
 * @returns The connection and the store.
 */
async function storeWith(
  name: string,
  molecules: readonly string[],
): Promise<{ db: DatabaseSync; store: MoleculeStore }> {
  const db = new DatabaseSync(join(directory, `${name}.sqlite`));
  db.exec('PRAGMA journal_mode = WAL');
  const store = await open(db);
  await commitIds(store, db, molecules);
  return { db, store };
}

/**
 * Opens a store on a connection, closed with the test file.
 * @param db - The connection.
 * @param checkRows - Molecules recomputed at opening.
 * @returns The store.
 */
async function open(db: DatabaseSync, checkRows = 32): Promise<MoleculeStore> {
  const store = await MoleculeStore.open(db, {
    threads: testThreads(2),
    checkRows,
  });
  opened.push({ db, store });
  return store;
}

/**
 * Commits molecules, rolling back when the store refuses.
 * @param store - The store.
 * @param db - Its connection.
 * @param molecules - The idCodes.
 * @returns Why the store refused, or undefined when it did not.
 */
async function refusal(
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

function setMeta(db: DatabaseSync, name: string, value: string | number) {
  db.prepare('UPDATE ocl_meta SET value = ? WHERE name = ?').run(value, name);
}

/**
 * Puts other bits in every screen plane, as a build with other screen keys would have.
 * @param db - The connection.
 */
function scrambleScreen(db: DatabaseSync): void {
  const update = db.prepare('UPDATE ocl_tile SET data = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, data FROM ocl_tile').all() as Array<{
    id: number;
    data: Uint8Array;
  }>) {
    const tile = tileViews(row.data);
    const used = tile.used[0] as number;
    const mask = used === 32 ? -1 : (1 << used) - 1;
    for (let plane = 512; plane < 1024; plane++) {
      tile.planes[plane] = ~(tile.planes[plane] as number) & mask;
    }
    update.run(tile.data, row.id);
  }
}

/**
 * Takes the idCode hashes out of a file, as a build without them wrote it.
 * @param db - The connection.
 */
function dropIdCodeHashes(db: DatabaseSync): void {
  db.exec('DROP INDEX ocl_molecule_idcode');
  db.exec('ALTER TABLE ocl_molecule DROP COLUMN idCodeHash');
}

function idsOf(db: DatabaseSync): number[] {
  return (
    db.prepare('SELECT id FROM ocl_molecule ORDER BY id').all() as Array<{
      id: number;
    }>
  ).map((row) => row.id);
}

function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) = 'ocl_' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

test('a file written before signatures and idCode hashes is refused, and rebuild() brings it to this build', async () => {
  const { db, store } = await storeWith('legacy', idCodes.slice(0, 150));
  await store.close();
  // What a build keeping neither signatures nor idCode hashes left.
  dropIdCodeHashes(db);
  db.exec(
    "DELETE FROM ocl_meta WHERE substr(name, 1, 10) = 'signature.' OR substr(name, 1, 8) = 'counted.' OR name = 'generation'",
  );
  setMeta(db, 'stamp', await computeLegacyStamp());
  db.exec('DROP TABLE ocl_bits');

  await expect(MoleculeStore.updates(db)).resolves.toStrictEqual({
    identity: false,
    tiles: [],
    counts: ['fragFp', 'screen', 'functions'],
    idCodeHash: true,
    rebuilding: false,
  });
  await expect(
    MoleculeStore.open(db, { threads: testThreads(2) }),
  ).rejects.toThrow(/no idCode hashes/);

  const steps: string[] = [];
  const result = await MoleculeStore.rebuild(db, {
    threads: testThreads(2),
    tilesPerStep: 3,
    onProgress: (progress) => steps.push(progress.step),
  });

  expect(result).toStrictEqual({
    rebuilt: [],
    counted: ['fragFp', 'screen', 'functions'],
    molecules: 150,
    hashed: 150,
  });
  expect(steps[0]).toBe('idCodeHash');
  expect(steps.at(-1)).toBe('tiles');

  const upgraded = await open(db, 150);

  expect(readMeta(db).stamp).toBe(await computeStamp());
  expect(upgraded.bitCounts()).toStrictEqual(bruteCounts(db));

  for (const [id, keys] of upgraded.keys(idsOf(db))) {
    expect(keys.idCodeHash, `id ${id}`).toBe(strongHash(keys.idCode));
  }

  // The store keeps the counts and the hashes of what it commits from now on.
  await commitIds(upgraded, db, idCodes.slice(150, 200));

  expect(upgraded.bitCounts()).toStrictEqual(bruteCounts(db));
  await expect(MoleculeStore.updates(db)).resolves.toStrictEqual({
    identity: false,
    tiles: [],
    counts: [],
    idCodeHash: false,
    rebuilding: false,
  });
});

test('the idCode hashes of a file lacking them: rebuild() adds the column and its index, and hashes what an older build commits meanwhile', async () => {
  const { db, store } = await storeWith('hashes', idCodes.slice(0, 120));
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
  const reopened = await open(db, 120);
  const [first] = idsOf(db);

  expect(
    reopened.byHashes('idCode', [
      reopened.keys([first as number]).get(first as number)
        ?.idCodeHash as bigint,
    ]),
  ).toStrictEqual([[first]]);
});

test('tiles holding another screen: the build refuses the file, and rebuild() computes them again beside them', async () => {
  const { db, store } = await storeWith('screen', idCodes.slice(0, 300));
  const before = store.bitCounts();
  await store.close();
  // What a build with other screen keys left: other screen planes, under its signature and stamp.
  scrambleScreen(db);
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
  const rebuilt = await open(db, 300);

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
  const { db, store } = await storeWith('paused', idCodes.slice(0, 200));
  await store.close();
  // Function bits counted under other keys.
  setMeta(db, 'counted.functions', '0000000000000000');
  const writer = await open(db);

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
  const { db, store: writer } = await storeWith(
    'concurrent',
    idCodes.slice(0, 600),
  );
  // The screen of the file is computed under other keys: the store opened before keeps writing.
  scrambleScreen(db);
  setMeta(db, 'signature.screen', '0000000000000000');
  setMeta(db, 'counted.screen', '0000000000000000');
  const job = new DatabaseSync(join(directory, 'concurrent.sqlite'));
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
  const reopened = await open(db, 2000);

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
  const { db, store } = await storeWith('foreign', idCodes.slice(0, 50));
  setMeta(db, 'stamp', `${FORMAT}:0123456789abcdef`);
  db.prepare(
    "UPDATE ocl_meta SET value = value + 1 WHERE name = 'generation'",
  ).run();

  await expect(refusal(store, db, idCodes.slice(50, 60))).resolves.toMatch(
    /rebuilt for another build/,
  );
});
