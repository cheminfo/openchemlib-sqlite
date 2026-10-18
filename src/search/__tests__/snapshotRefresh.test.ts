/* eslint-disable no-await-in-loop -- each round builds on the last */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import { readSnapshotPosition } from '../snapshot/snapshotPosition.ts';

import { RESTORED, expectExact, openWithSnapshot } from './snapshotHelpers.ts';

/** An id's low bits, its seq. */
const SEQ_MASK = SEQ_SPAN - 1;

let directory: string;
let file: string;
let snapshot: string;
let db: DatabaseSync;
let store: MoleculeStore;
let idCodes: string[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-refresh-'));
  file = join(directory, 'db.sqlite');
  snapshot = join(directory, 'index.snapshot');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  idCodes = readIdCodes();
  await addMolecules(db, store, idCodes.slice(0, 600));
  await openWithSnapshot({ file, snapshot });
}, 120_000);

afterAll(async () => {
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

const exact = (index: MoleculeIndex) => expectExact(index, db);

/**
 * Adds molecules, gives old ones a source, removes a few.
 * @param from - The first idCode added.
 * @param count - How many.
 */
async function grow(from: number, count: number): Promise<void> {
  await addMolecules(db, store, idCodes.slice(from, from + count), {
    seed: from,
  });
  const old = (
    db
      .prepare('SELECT id FROM molecules ORDER BY id LIMIT 40 OFFSET ?')
      .all(from / 10) as Array<{ id: number }>
  ).map((row) => row.id);
  db.exec('BEGIN IMMEDIATE');
  const add = db.prepare(
    'INSERT OR IGNORE INTO molecule_sources (sourceId, moleculeId) VALUES (?, ?)',
  );
  for (const id of old.slice(0, 30)) add.run(2, id);
  const removed = old.slice(30, 33);
  for (const id of removed) {
    db.prepare('DELETE FROM molecule_sources WHERE moleculeId = ?').run(id);
    db.prepare('DELETE FROM molecules WHERE id = ?').run(id);
  }
  store.remove(removed);
  db.exec('COMMIT');
}

test('a large catch-up is saved again by itself, and the next open has nothing to catch up', async () => {
  const position = await readSnapshotPosition(snapshot);
  await grow(600, 100);
  db.exec("INSERT INTO sources (id, name, isPublic) VALUES (4, 'Late', 1)");
  db.exec(
    'INSERT INTO molecule_sources (sourceId, moleculeId) SELECT 4, id FROM molecules LIMIT 25',
  );
  const { watermark = 0, changeId = 0 } = position ?? {};
  const placed = db
    .prepare(
      `SELECT count(*) AS n FROM ocl_molecule WHERE (id & ${SEQ_MASK}) > ?`,
    )
    .get(watermark) as { n: number };
  const changed = db
    .prepare(
      `SELECT count(DISTINCT moleculeId) AS n FROM entry_changes
        WHERE id > ? AND (moleculeId & ${SEQ_MASK}) <= ?`,
    )
    .get(changeId, watermark) as { n: number };
  const steps: string[] = [];
  let saved = noop;
  const save = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    pollMs: 3_600_000,
    snapshot,
    snapshotRefreshShare: 0.05,
    onProgress: ({ step, note, finished }) => {
      if (!finished) return;
      steps.push(note === undefined ? step : `${step}: ${note}`);
      if (step === 'save') saved();
    },
  });
  try {
    await index.poll();
    await save;
    const caughtUp = await index.tailStats();

    // The molecules the tail placed are read once: their changes are spared.
    expect(caughtUp.rows).toBe(placed.n);
    expect(caughtUp.changes).toBe(changed.n);

    await exact(index);
  } finally {
    await index.close();
  }
  const blocks = await blocksOfLoad();
  const again = await openWithSnapshot({ file, snapshot }, async (opened) => {
    await exact(opened);
    const stats = await opened.tailStats();

    // Read back as a load lays it out: no append block, nothing left to catch up.
    expect(stats.blocks).toBe(blocks);
    expect(stats.rows).toBe(0);
    expect(stats.changes).toBe(0);
  });

  expect(steps).toStrictEqual([...RESTORED, 'save']);
  expect(again).toStrictEqual(RESTORED);
}, 120_000);

test('saving again and again keeps every answer exact', async () => {
  for (const from of [700, 760, 820]) {
    await grow(from, 60);
    const steps = await openWithSnapshot({ file, snapshot }, async (index) => {
      await index.poll();

      await expect(index.saveSnapshot()).resolves.toBeNull();

      await exact(index);
    });

    expect(steps).toStrictEqual([...RESTORED, 'save']);
  }
  const steps = await openWithSnapshot({ file, snapshot }, async (index) => {
    await exact(index);
    const stats = await index.tailStats();

    expect(stats.rows).toBe(0);
  });

  expect(steps).toStrictEqual(RESTORED);
}, 120_000);

test('molecules committed during a save are placed once, after it', async () => {
  const steps = await openWithSnapshot({ file, snapshot }, async (index) => {
    const saving = index.saveSnapshot();
    await grow(880, 50);
    await index.poll();

    await expect(saving).resolves.toBeNull();

    await exact(index);
  });
  const again = await openWithSnapshot({ file, snapshot }, exact);

  expect(steps).toStrictEqual([...RESTORED, 'save']);
  expect(again).toStrictEqual(RESTORED);
}, 120_000);

test('a closed index stops its save and leaves the snapshot as it was', async () => {
  await grow(930, 40);
  const before = readFileSync(snapshot);
  let note: Promise<string | null> = Promise.resolve(null);
  await openWithSnapshot({ file, snapshot }, async (index) => {
    await index.poll();
    note = index.saveSnapshot();
  });

  await expect(note).resolves.toBe('not saved: the index closed');
  expect(readFileSync(snapshot).equals(before)).toBe(true);
  expect(
    readdirSync(directory).filter((name) => name.endsWith('.tmp')),
  ).toStrictEqual([]);

  const again = await openWithSnapshot({ file, snapshot }, exact);

  expect(again).toStrictEqual(RESTORED);
}, 120_000);

test('the position of a snapshot is read from its header', async () => {
  await openWithSnapshot({ file, snapshot }, async (index) => {
    await index.poll();

    await expect(index.saveSnapshot()).resolves.toBeNull();
  });
  const { seq } = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entry_changes'")
    .get() as { seq: number };
  const notSnapshot = join(directory, 'not.snapshot');
  writeFileSync(notSnapshot, 'nothing of a snapshot here');

  await expect(readSnapshotPosition(snapshot)).resolves.toStrictEqual({
    watermark: store.lastSeq(),
    changeId: seq,
  });
  await expect(
    readSnapshotPosition(join(directory, 'none')),
  ).resolves.toBeNull();
  await expect(readSnapshotPosition(notSnapshot)).resolves.toBeNull();
}, 120_000);

/**
 * The blocks a load of the file lays out.
 * @returns Their count.
 */
async function blocksOfLoad(): Promise<number> {
  let blocks = 0;
  await openWithSnapshot({ file, snapshot: '' }, async (index) => {
    const stats = await index.tailStats();
    blocks = Number(stats.blocks);
  });
  return blocks;
}

function noop(): void {
  // Replaced once the promise exists.
}
