import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import {
  getFunction,
  getIndex,
  getNoStereoHash,
  getScreen,
  strongHash,
} from 'openchemlib-search-wasm';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { countBits } from '../../chemistry/bits.ts';
import { SEQ_SPAN, atomCountOf } from '../../chemistry/key.ts';
import { computeStamp } from '../../chemistry/stamp.ts';
import { slotWords } from '../../chemistry/tile.ts';
import { tileViews } from '../../chemistry/tileRecord.ts';
import { MoleculeStore } from '../MoleculeStore.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const ALANINE_L = smiles('C[C@H](N)C(=O)O');
const ALANINE_D = smiles('C[C@@H](N)C(=O)O');
const ALANINE = smiles('CC(N)C(=O)O');
const KETO = smiles('CC(=O)CC(=O)C');
const ENOL = smiles('CC(O)=CC(=O)C');
const BENZENE = smiles('c1ccccc1');

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-store-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
});

afterAll(async () => {
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('prepare computes every stored value from the idCode, and commit writes them in the caller transaction', async () => {
  const batch = await store.prepare([BENZENE, ALANINE_L, '', BENZENE]);

  expect(batch.molecules.map((molecule) => molecule.error)).toStrictEqual([
    undefined,
    undefined,
    'the idCode cannot be read',
    undefined,
  ]);
  expect(batch.molecules[0]?.idCode).toBe(BENZENE);
  expect(batch.molecules[0]?.atoms).toBe(6);
  expect(batch.molecules[0]?.noStereoHash).toBe(getNoStereoHash(BENZENE));
  expect(() => store.commit(batch)).toThrow(/transaction/);

  db.exec('BEGIN IMMEDIATE');
  const results = store.commit(batch);
  db.exec('COMMIT');

  expect(results.map((result) => result?.created)).toStrictEqual([
    true,
    true,
    undefined,
    false,
  ]);
  expect(results[3]?.id).toBe(results[0]?.id);
  expect(atomCountOf(results[0]?.id as number)).toBe(6);
  expect((results[0]?.id as number) % SEQ_SPAN).toBe(1);
  expect((results[1]?.id as number) % SEQ_SPAN).toBe(2);
  expect(store.count()).toBe(2);
  expect(store.lastSeq()).toBe(2);

  const tile = db
    .prepare('SELECT data FROM ocl_tile WHERE id >= ? AND id < ?')
    .get(6 * 2 ** 37 + 78 * 2 ** 21, 6 * 2 ** 37 + 79 * 2 ** 21) as {
    data: Uint8Array;
  };
  const views = tileViews(tile.data);
  const words = slotWords(views, 0);

  expect(views.seqs[0]).toBe(1);
  expect(views.used[0]).toBe(1);
  expect(Array.from(words.subarray(0, 16))).toStrictEqual(
    Array.from(getIndex(BENZENE)),
  );
  expect(Array.from(words.subarray(16, 32))).toStrictEqual(
    Array.from(getScreen(BENZENE)),
  );
  expect(Array.from(words.subarray(32))).toStrictEqual(
    Array.from(getFunction(BENZENE)),
  );
  expect(views.bits[0]).toBe(countBits(getIndex(BENZENE), 0, 16));
});

test('a batch the store did not prepare is refused', () => {
  db.exec('BEGIN IMMEDIATE');
  try {
    expect(() => store.commit({ molecules: [] })).toThrow(
      /prepared by this store/,
    );
  } finally {
    db.exec('ROLLBACK');
  }
});

test('identity: find, stereoisomers, tautomers, byHashes and keys', async () => {
  const batch = await store.prepare([ALANINE_D, ALANINE, KETO, ENOL]);
  db.exec('BEGIN IMMEDIATE');
  const [d, plain, keto, enol] = store
    .commit(batch)
    .map((result) => result?.id as number);
  db.exec('COMMIT');
  const [l] = await store.find([ALANINE_L]);

  await expect(
    store.find([ALANINE_D, ALANINE, smiles('CCCCCC'), '']),
  ).resolves.toStrictEqual([d, plain, undefined, undefined]);
  await expect(store.stereoisomers(ALANINE)).resolves.toStrictEqual(
    [l, d, plain].toSorted((a, b) => (a as number) - (b as number)),
  );
  await expect(
    store.stereoisomers(ALANINE, { after: l as number, limit: 1 }),
  ).resolves.toHaveLength(1);
  await expect(store.tautomers(KETO)).resolves.toStrictEqual(
    [keto, enol].toSorted((a, b) => (a as number) - (b as number)),
  );

  const keys = store.keys([keto as number, 12_345]);

  expect([...keys.keys()]).toStrictEqual([keto]);
  expect(keys.get(keto as number)?.idCode).toBe(KETO);
  expect(keys.get(keto as number)?.idCodeHash).toBe(strongHash(KETO));
  expect(
    store.byHashes('idCode', [strongHash(KETO), strongHash(ENOL), 7n]),
  ).toStrictEqual([[keto], [enol], []]);
  expect(
    store.byHashes('tautomer', [
      keys.get(keto as number)?.tautomerHash as bigint,
      7n,
    ]),
  ).toStrictEqual([
    [keto, enol].toSorted((a, b) => (a as number) - (b as number)),
    [],
  ]);
});

test('remove empties the tile slot, keeps it used and never reuses the seq', async () => {
  const [id] = await store.find([KETO]);
  db.exec('BEGIN IMMEDIATE');

  expect(store.remove([id as number, 999])).toBe(1);

  db.exec('COMMIT');

  await expect(store.find([KETO])).resolves.toStrictEqual([undefined]);

  const seq = store.lastSeq();
  const batch = await store.prepare([KETO]);
  db.exec('BEGIN IMMEDIATE');
  const [again] = store.commit(batch);
  db.exec('COMMIT');

  expect((again?.id as number) % SEQ_SPAN).toBe(seq + 1);
});

test('reopening checks the stamp and a recomputed sample', async () => {
  const reopened = await MoleculeStore.open(db, {
    threads: testThreads(1),
    checkRows: 64,
  });
  await reopened.close();
  db.prepare(
    "UPDATE ocl_meta SET value = 'openchemlib-sqlite 6:0000000000000000' WHERE name = 'stamp'",
  ).run();

  await expect(
    MoleculeStore.open(db, { threads: testThreads(1) }),
  ).rejects.toThrow(/stamp/);

  db.prepare("UPDATE ocl_meta SET value = ? WHERE name = 'stamp'").run(
    await computeStamp(),
  );
  // Bit 0 of plane 0 flipped in every tile: slot 0's FragFp differs in each of them.
  const tiles = db.prepare('SELECT id, data FROM ocl_tile').all() as Array<{
    id: number;
    data: Uint8Array;
  }>;
  const update = db.prepare('UPDATE ocl_tile SET data = ? WHERE id = ?');
  for (const tile of tiles) {
    const corrupted = new Uint8Array(tile.data);
    corrupted[0] = (corrupted[0] as number) ^ 1;
    update.run(corrupted, tile.id);
  }

  await expect(
    MoleculeStore.open(db, { threads: testThreads(1), checkRows: 64 }),
  ).rejects.toThrow(/do not hold what this build computes/);

  for (const tile of tiles) update.run(tile.data, tile.id);
});

test('a file of openchemlib-sqlite 5.x is refused, not opened as an empty store', async () => {
  const five = new DatabaseSync(':memory:');
  five.exec(
    'CREATE TABLE ocl_ss_index (id INTEGER PRIMARY KEY, idCode TEXT NOT NULL)',
  );

  await expect(
    MoleculeStore.open(five, { threads: testThreads(1) }),
  ).rejects.toThrow(/openchemlib-sqlite 5\.x/);
  expect(
    five
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name),
  ).toStrictEqual(['ocl_ss_index']);

  five.close();
});
