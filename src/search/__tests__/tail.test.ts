/* eslint-disable no-await-in-loop -- writes, polls and checks run one after the other */
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
import {
  readAll,
  readTruth,
  similarityTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SearchOptions } from '../pages.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const QUERIES = [
  '',
  smiles('c1ccccc1'),
  smiles('Oc1ccccc1'),
  smiles('ClCCCO'),
  'gOp@DjWkB@@Mi`',
];
const SETS: SearchOptions[] = [
  {},
  { sets: ['source:2'] },
  { sets: ['source:3'] },
  { sets: ['source:4'] },
  { keyMin: 150, keyMax: 300, filters: { logP: { min: 0 } } },
];

let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let late: string[];

/**
 * Every query × set paged to the end through the index, against brute force over SQL.
 * @param label - What the check follows.
 */
async function expectExact(label: string): Promise<void> {
  await index.poll();
  const rows = readTruth(db);
  for (const query of QUERIES) {
    for (const options of SETS) {
      const expected = substructureTruth(rows, query, options);
      const { ids } = await readAll(index, query, { ...options, limit: 1000 });

      expect(
        ids,
        `${label}: ${query || 'browse'} ${JSON.stringify(options)}`,
      ).toStrictEqual(expected);

      const tight = await readAll(index, query, {
        ...options,
        limit: 40,
        budgetMs: 2,
      });

      expect(tight.ids, `${label}, 2 ms pages`).toStrictEqual(expected);
    }
  }
  const benzene = smiles('c1ccccc1');
  // The tail counts the screen bits of each row it appends: every fingerprint must agree.
  for (const fingerprint of ['fragFp', 'screen', 'both'] as const) {
    const similar = await index.similarity(benzene, {
      threshold: 0.5,
      fingerprint,
      limit: 1000,
      budgetMs: 60_000,
    });

    expect(similar.hits, `${label}: similarity, ${fingerprint}`).toStrictEqual(
      similarityTruth(rows, benzene, 0.5, {}, fingerprint),
    );
  }
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-tail-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 30000');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(4) });
  const idCodes = readIdCodes().slice(0, 1600);
  const cut = Math.floor(idCodes.length * 0.75);
  late = idCodes.slice(cut);
  await addMolecules(db, store, idCodes.slice(0, cut), { seed: 3 });
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(3),
    readers: testThreads(2),
    blockRows: 512,
    firstSliceRows: 64,
    appendBlockRows: 64,
    // Little headroom: the bitmaps grow, copied, while polls place rows.
    headroomRows: 64,
    headroomShare: 0,
    pollMs: 3_600_000,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('new molecules, into bands the image holds and new ones, are found once published', async () => {
  await addMolecules(db, store, late.slice(0, 200), { seed: 11 });
  const big = smiles('C'.repeat(120));
  const [bigId] = await addMolecules(db, store, [big], { sources: [1] });
  await index.poll();
  await index.waitForSeq(store.lastSeq(), 10_000);
  const page = await index.substructure(big, { limit: 10 });

  expect(page.hits.map((hit) => hit.id)).toStrictEqual([bigId]);

  await expectExact('new molecules');
}, 120_000);

test('entries added, removed and moved, private-only molecules, removed molecules, a late source', async () => {
  const old = (
    db
      .prepare('SELECT id FROM molecules ORDER BY id LIMIT 600')
      .all() as Array<{ id: number }>
  ).map((row) => row.id);
  db.exec('BEGIN IMMEDIATE');
  const add = db.prepare(
    'INSERT OR IGNORE INTO molecule_sources (sourceId, moleculeId) VALUES (?, ?)',
  );
  const remove = db.prepare(
    'DELETE FROM molecule_sources WHERE sourceId = ? AND moleculeId = ?',
  );
  for (const id of old.slice(0, 100)) add.run(2, id);
  for (const id of old.slice(100, 160)) remove.run(1, id);
  for (const id of old.slice(160, 200)) {
    db.prepare(
      'DELETE FROM molecule_sources WHERE moleculeId = ? AND sourceId IN (1, 2)',
    ).run(id);
    add.run(3, id);
  }
  db.exec("INSERT INTO sources (id, name, isPublic) VALUES (4, 'Late', 1)");
  for (const id of old.slice(200, 260)) add.run(4, id);
  db.exec('COMMIT');
  db.exec('BEGIN IMMEDIATE');
  const removed = old.slice(260, 280);
  for (const id of removed) {
    db.prepare('DELETE FROM molecule_sources WHERE moleculeId = ?').run(id);
    db.prepare('DELETE FROM molecules WHERE id = ?').run(id);
  }

  expect(store.remove(removed)).toBe(20);

  db.exec('COMMIT');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE molecules SET weight = weight + 333.5 WHERE id = ?').run(
    old[300] as number,
  );
  db.prepare('UPDATE molecules SET logP = -99 WHERE id = ?').run(
    old[301] as number,
  );
  db.exec('COMMIT');
  await expectExact('set changes');

  expect(index.sets).toContain('source:4');
}, 120_000);

test('one cell filled poll after poll: its append area moves while published', async () => {
  const isomers = new Set<string>();
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      if (i === j) continue;
      const atoms = Array.from({ length: 12 }, () => 'C');
      atoms[i] = 'C(O)';
      atoms[j] = 'C(Cl)';
      isomers.add(smiles(atoms.join('')));
    }
  }
  const list = [...isomers].slice(0, 130);
  const rowsBefore = index.rowCount;
  const countBefore = store.count();
  for (let at = 0; at < list.length; at += 10) {
    await addMolecules(db, store, list.slice(at, at + 10), {
      sources: [at % 20 === 0 ? 1 : 2],
    });
    await index.poll();
  }
  await expectExact('area moves');

  const stats = await index.tailStats();

  expect(stats.moves).toBeGreaterThanOrEqual(2);
  expect(stats.anomalies).toBe(0);

  expect(index.rowCount - rowsBefore).toBe(store.count() - countBefore);
}, 120_000);

test('commits during searches: every answer stays in (key, id) order, then exact', async () => {
  const state = { searching: true };
  const benzene = smiles('c1ccccc1');
  const searches = (async () => {
    let answered = 0;
    while (state.searching) {
      const page = await index.substructure(benzene, {
        limit: 200,
        budgetMs: 200,
      });
      for (let i = 1; i < page.hits.length; i++) {
        const a = page.hits[i - 1] as { key: number; id: number };
        const b = page.hits[i] as { key: number; id: number };

        expect(a.key < b.key || (a.key === b.key && a.id < b.id)).toBe(true);
      }
      answered++;
    }
    return answered;
  })();
  for (let at = 200; at < late.length; at += 50) {
    await addMolecules(db, store, late.slice(at, at + 50), { seed: at });
    await index.poll();
  }
  state.searching = false;

  await expect(searches).resolves.toBeGreaterThan(0);

  await expectExact('writes during searches');
}, 120_000);
