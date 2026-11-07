import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getIndexes } from 'openchemlib-search-wasm';
import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import { readTruth } from '../../__tests__/truth.ts';
import { makeId } from '../../chemistry/key.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SimilarityFingerprint } from '../fingerprint.ts';
import type { KeySet } from '../fingerprintRows.ts';

let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let late: string[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-fingerprint-rows-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 30000');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(4) });
  const idCodes = readIdCodes().slice(0, 1600);
  late = idCodes.slice(1400);
  await addMolecules(db, store, idCodes.slice(0, 1400), { seed: 5 });
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    readers: testThreads(2),
    // Small blocks, so the molecules asked lie in many of them.
    blockRows: 512,
    appendBlockRows: 64,
    pollMs: 3_600_000,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

const STORED: readonly KeySet[] = ['fragFp', 'screen', 'functions'];

/**
 * The words key sets take of each molecule's 48 stored words.
 * @param rows - The molecules, read with their keys.
 * @param keySets - The key sets, in order.
 * @returns Their words, one molecule after the other.
 */
function expectedWords(
  rows: readonly TruthRow[],
  keySets: readonly KeySet[],
): Int32Array {
  const width = 16 * keySets.length;
  const words = new Int32Array(rows.length * width);
  for (const [position, row] of rows.entries()) {
    for (const [order, keySet] of keySets.entries()) {
      const first = 16 * STORED.indexOf(keySet);
      words.set(
        row.keys.subarray(first, first + 16),
        position * width + 16 * order,
      );
    }
  }
  return words;
}

test('every fingerprint of every molecule reads as the store wrote it', async () => {
  const rows = readTruth(db, { keys: true });

  expect(rows).toHaveLength(1400);

  const ids = rows.map((row) => row.id);
  const cases: Array<[SimilarityFingerprint, KeySet[]]> = [
    ['fragFp', ['fragFp']],
    ['screen', ['screen']],
    ['both', ['fragFp', 'screen']],
    ['functions', ['functions']],
  ];
  for (const [fingerprint, keySets] of cases) {
    // eslint-disable-next-line no-await-in-loop -- one fingerprint after the other
    const read = await index.fingerprints(ids, { fingerprint });

    expect(read.keySets).toStrictEqual(keySets);
    expect(read.width).toBe(16 * keySets.length);
    expect(read.found).toStrictEqual(new Uint8Array(1400).fill(1));
    expect(read.words).toStrictEqual(expectedWords(rows, keySets));
  }
});

test('any key sets are read, in the order asked', async () => {
  const rows = readTruth(db, { keys: true });
  const ids = rows.map((row) => row.id);
  const cases: KeySet[][] = [
    ['fragFp', 'functions'],
    ['functions', 'fragFp'],
    ['screen', 'functions'],
    ['fragFp', 'screen', 'functions'],
    ['functions', 'screen', 'fragFp'],
  ];
  for (const keySets of cases) {
    // eslint-disable-next-line no-await-in-loop -- one list after the other
    const read = await index.fingerprints(ids, { fingerprint: keySets });

    expect(read.keySets).toStrictEqual(keySets);
    expect(read.width).toBe(16 * keySets.length);
    expect(read.words).toStrictEqual(expectedWords(rows, keySets));
  }
});

test('the FragFp read is the one OpenChemLib computes from the idCode', async () => {
  const rows = readTruth(db).slice(0, 50);
  const read = await index.fingerprints(rows.map((row) => row.id));
  const computed = getIndexes(rows.map((row) => row.idCode));
  for (const [position, words] of computed.entries()) {
    expect(
      read.words.subarray(16 * position, 16 * position + 16),
    ).toStrictEqual(words);
  }
});

test('ids come back in the order asked, twice when asked twice, zeros when unknown', async () => {
  const rows = readTruth(db, { keys: true });
  const picked = [rows[900], rows[3], rows[900], rows[1200]] as TruthRow[];
  const unknown = makeId(7, 999_999_999);
  const read = await index.fingerprints([
    ...picked.map((row) => row.id),
    unknown,
  ]);

  expect(read.found).toStrictEqual(new Uint8Array([1, 1, 1, 1, 0]));
  expect(read.words.subarray(0, 64)).toStrictEqual(
    expectedWords(picked, ['fragFp']),
  );
  expect(read.words.subarray(64)).toStrictEqual(new Int32Array(16));

  const empty = await index.fingerprints([]);

  expect(empty.words).toHaveLength(0);
});

test('more molecules than one turn reads, in many blocks', async () => {
  const rows = readTruth(db, { keys: true });
  const asked = [...rows, ...rows, ...rows, ...rows].toReversed();
  const read = await index.fingerprints(asked.map((row) => row.id));

  expect(read.found).toStrictEqual(new Uint8Array(asked.length).fill(1));
  expect(read.words).toStrictEqual(expectedWords(asked, ['fragFp']));
});

test('molecules the tail placed are read, and removed ones are not found', async () => {
  const committed = await addMolecules(db, store, late, { seed: 9 });
  const added = committed.filter((id): id is number => id !== undefined);
  await index.poll();
  await index.waitForSeq(store.lastSeq(), 10_000);
  const byId = new Map(
    readTruth(db, { keys: true }).map((row) => [row.id, row]),
  );
  const fresh = added.map((id) => byId.get(id) as TruthRow);
  const read = await index.fingerprints(added, { fingerprint: 'both' });

  expect(read.found).toStrictEqual(new Uint8Array(added.length).fill(1));
  expect(read.words).toStrictEqual(expectedWords(fresh, ['fragFp', 'screen']));

  const gone = added.slice(0, 5);
  db.exec('BEGIN IMMEDIATE');
  for (const id of gone) {
    db.prepare('DELETE FROM molecule_sources WHERE moleculeId = ?').run(id);
    db.prepare('DELETE FROM molecules WHERE id = ?').run(id);
  }

  expect(store.remove(gone)).toBe(5);

  db.exec('COMMIT');
  await index.poll();
  const after = await index.fingerprints([...gone, added[10] as number]);

  expect(after.found).toStrictEqual(new Uint8Array([0, 0, 0, 0, 0, 1]));
}, 120_000);

test('a stopped request and unknown or repeated keys are refused', async () => {
  const ids = readTruth(db).map((row) => row.id);
  const controller = new AbortController();
  controller.abort(new Error('stopped'));

  await expect(
    index.fingerprints(ids, { signal: controller.signal }),
  ).rejects.toThrow('stopped');
  await expect(
    index.fingerprints(ids, {
      fingerprint: 'ecfp' as SimilarityFingerprint,
    }),
  ).rejects.toThrow(/ecfp/);
  await expect(index.fingerprints(ids, { fingerprint: [] })).rejects.toThrow(
    'the key sets read are at least one',
  );

  const notAKeySet: unknown = ['both'];

  await expect(
    index.fingerprints(ids, { fingerprint: notAKeySet as KeySet[] }),
  ).rejects.toThrow(
    `a key set is 'fragFp', 'screen' or 'functions', not "both"`,
  );
  await expect(
    index.fingerprints(ids, { fingerprint: ['fragFp', 'screen', 'fragFp'] }),
  ).rejects.toThrow(`the key set 'fragFp' is asked twice`);
});
