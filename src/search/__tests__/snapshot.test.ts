import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import { SEQ_SPAN } from '../../chemistry/key.ts';
import {
  computeSignatures,
  computeStamp,
  stampOf,
} from '../../chemistry/stamp.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import type { MoleculeIndex } from '../MoleculeIndex.ts';
import type { IndexSpec } from '../spec.ts';

import type { SnapshotOpen } from './snapshotHelpers.ts';
import { RESTORED, expectExact, openWithSnapshot } from './snapshotHelpers.ts';

let directory: string;
let file: string;
let snapshot: string;
let db: DatabaseSync;
let store: MoleculeStore;
let idCodes: string[];
let savedSeq: number;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-snapshot-'));
  file = join(directory, 'db.sqlite');
  snapshot = join(directory, 'index.snapshot');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  idCodes = readIdCodes();
  await addMolecules(db, store, idCodes.slice(0, 600));
}, 120_000);

afterAll(async () => {
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Opens the test database with its snapshot, unless the test names others.
 * @param open - What the test changes.
 * @param check - What to do with the index while it is open.
 * @returns The steps finished.
 */
function openIndex(
  open: Partial<SnapshotOpen> = {},
  check?: (index: MoleculeIndex) => Promise<void>,
): Promise<string[]> {
  return openWithSnapshot({ file, snapshot, ...open }, check);
}

const exact = (index: MoleculeIndex) => expectExact(index, db);

test('a first open loads from the store, then saves the index', async () => {
  savedSeq = store.lastSeq();
  const steps = await openIndex({}, exact);

  expect(steps).toStrictEqual([
    'snapshot: none saved yet',
    'plan',
    'cells',
    'tiles',
    'index',
    'columns',
    'zones',
    'sets',
    'frequencies',
    'save',
    'tail',
    'workers',
  ]);
  expect(existsSync(snapshot)).toBe(true);
}, 120_000);

test('the next open reads the snapshot alone, and answers as a load does', async () => {
  const steps = await openIndex({}, async (index) => {
    expect(index.rowCount).toBe(store.count());

    await exact(index);
  });

  expect(steps).toStrictEqual(RESTORED);
}, 120_000);

test('what changed since the snapshot is caught up from the store', async () => {
  await addMolecules(db, store, idCodes.slice(600, 700), { seed: 7 });
  const old = (
    db
      .prepare('SELECT id FROM molecules ORDER BY id LIMIT 100')
      .all() as Array<{ id: number }>
  ).map((row) => row.id);
  db.exec('BEGIN IMMEDIATE');
  const add = db.prepare(
    'INSERT OR IGNORE INTO molecule_sources (sourceId, moleculeId) VALUES (?, ?)',
  );
  for (const id of old.slice(0, 50)) add.run(2, id);
  db.exec("INSERT INTO sources (id, name, isPublic) VALUES (4, 'Late', 1)");
  for (const id of old.slice(50, 80)) add.run(4, id);
  const removed = old.slice(80, 90);
  for (const id of removed) {
    db.prepare('DELETE FROM molecule_sources WHERE moleculeId = ?').run(id);
    db.prepare('DELETE FROM molecules WHERE id = ?').run(id);
  }

  expect(store.remove(removed)).toBe(10);

  db.exec('COMMIT');
  const steps = await openIndex({}, exact);

  expect(steps).toStrictEqual(RESTORED);
}, 120_000);

test('a snapshot too far behind the store is replaced by a load', async () => {
  const behind = store.lastSeq() - savedSeq;
  const stale = await openIndex({ options: { snapshotStaleShare: 0.01 } });
  const again = await openIndex({}, exact);

  expect(behind).toBeGreaterThan(0.01 * 600);
  expect(stale[0]).toBe(`snapshot: ${behind} molecules behind the store`);
  expect(stale).toContain('save');
  expect(again).toStrictEqual(RESTORED);
}, 120_000);

test('a snapshot saved under another specification is refused, and replaced', async () => {
  const spec: IndexSpec = {
    ...SPEC,
    columns: { ...SPEC.columns, filters: SPEC.columns.filters?.slice(0, 2) },
  };
  const other = await openIndex({ spec });
  const back = await openIndex();
  const again = await openIndex();

  expect(other[0]).toBe('snapshot: saved under another specification');
  expect(back[0]).toBe('snapshot: saved under another specification');
  expect(again).toStrictEqual(RESTORED);
}, 120_000);

test('a snapshot of another database file is refused', async () => {
  const copy = join(directory, 'copy.sqlite');
  const copied = join(directory, 'copy.snapshot');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(file, copy);
  copyFileSync(snapshot, copied);
  const steps = await openIndex({ file: copy, snapshot: copied });

  expect(steps[0]).toBe('snapshot: saved from another database file');
}, 120_000);

test('a snapshot cut short is refused, then saved whole again', async () => {
  const bytes = readFileSync(snapshot);
  writeFileSync(snapshot, bytes.subarray(0, -8));
  const cut = await openIndex();
  const again = await openIndex();

  expect(cut[0]).toBe('snapshot: cut short');
  expect(cut).toContain('save');
  expect(statSync(snapshot).size).toBe(bytes.length);
  expect(again).toStrictEqual(RESTORED);
}, 120_000);

test('a snapshot the pruned change log no longer reaches is refused', async () => {
  const { id } = db
    .prepare('SELECT id FROM molecules ORDER BY id LIMIT 1')
    .get() as { id: number };
  db.prepare(
    'INSERT OR IGNORE INTO molecule_sources (sourceId, moleculeId) VALUES (4, ?)',
  ).run(id);
  db.exec('DELETE FROM entry_changes');
  const steps = await openIndex({}, exact);

  expect(steps[0]).toBe(
    'snapshot: the change log no longer reaches back to it',
  );
  expect(steps).toContain('save');
}, 120_000);

test('a snapshot whose newest molecule was removed since is still read back', async () => {
  const { id } = db
    .prepare(
      `SELECT id FROM ocl_molecule ORDER BY (id & ${SEQ_SPAN - 1}) DESC LIMIT 1`,
    )
    .get() as { id: number };
  db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM molecule_sources WHERE moleculeId = ?').run(id);
  db.prepare('DELETE FROM molecules WHERE id = ?').run(id);

  expect(store.remove([id])).toBe(1);

  db.exec('COMMIT');
  const steps = await openIndex({}, exact);

  expect(steps).toStrictEqual(RESTORED);
}, 120_000);

test('a snapshot of a build whose function keys differ, as one written before they were stored, is refused', async () => {
  const stamp = await computeStamp();
  const other = await stampOf({
    ...(await computeSignatures()),
    functions: '0000000000000000',
  });
  const bytes = readFileSync(snapshot);
  const at = bytes.indexOf(stamp, 0, 'latin1');

  expect(at).toBeGreaterThan(0);
  expect(other).toHaveLength(stamp.length);

  bytes.write(other, at, 'latin1');
  writeFileSync(snapshot, bytes);
  const steps = await openIndex({}, exact);

  expect(steps[0]).toBe(
    'snapshot: saved by another build of openchemlib-sqlite',
  );
  expect(steps).toContain('save');
  await expect(openIndex()).resolves.toStrictEqual(RESTORED);
}, 120_000);
