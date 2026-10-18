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
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';

/** The vanadium self-query of the fat campaigns: 16 disconnected V atoms. */
const V16_QUERY = 'f``@@H@]DNaGQchItTzF]GN`WQKhUtZzC]EnawQ{h@@H';
const V16_MOLECULE = 'f``@@H@]DNaGQchItTzF]GN`WQKhUtZzC]EnawQ{h@@@';
/** Molecules with fewer V atoms but enough atoms: they pass the floor and the screen, and the verifier backtracks over them for ever. */
const POOR = [
  [15, 'CCO'],
  [14, 'CCCO'],
  [12, 'CCCCCO'],
].map(([v, rest]) =>
  OCL.Molecule.fromSmiles(
    `${Array.from({ length: v as number }, () => '[V]').join('.')}.${rest as string}`,
  ).getIDCode(),
);
const SLACK_MS = 150;

let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
const added: Array<{ id: number; key: number }> = [];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-watchdog-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, readIdCodes().slice(0, 300));
  // The vanadium molecules keyed by their own weight, so their order is known: V12, V14, V15, V16.
  const batch = await store.prepare([V16_MOLECULE, ...POOR]);
  db.exec('BEGIN IMMEDIATE');
  const results = store.commit(batch);
  for (const [i, result] of results.entries()) {
    const idCode = batch.molecules[i]?.idCode as string;
    const key = OCL.Molecule.fromIDCode(idCode, false).getMolecularFormula()
      .relativeWeight;
    db.prepare(
      'INSERT INTO molecules (id, weight, logP, hba, charge) VALUES (?, ?, 0, 0, 0)',
    ).run(result?.id as number, key);
    db.prepare(
      'INSERT INTO molecule_sources (sourceId, moleculeId) VALUES (1, ?)',
    ).run(result?.id as number);
    added.push({ id: result?.id as number, key });
  }
  db.exec('COMMIT');
}, 120_000);

afterAll(async () => {
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a hung verification: the page answers by its deadline, an exact prefix; a seek passes it; the next search answers on time', async () => {
  const index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    follow: false,
    watchdogGraceMs: 300,
  });
  try {
    const benzene = OCL.Molecule.fromSmiles('c1ccccc1').getIDCode();
    const reference = await index.substructure(benzene, { limit: 24 });
    const lightest = Math.min(...added.slice(1).map((row) => row.key));
    let started = performance.now();
    const hung = await index.substructure(V16_QUERY, {
      limit: 24,
      budgetMs: 1000,
    });
    const hungMs = performance.now() - started;

    expect(hungMs).toBeLessThanOrEqual(1000 + SLACK_MS);
    expect(hung.partial).toBe(true);
    expect(hung.hits).toStrictEqual([]);
    expect(hung.next?.key).toBeLessThanOrEqual(lightest);

    started = performance.now();
    const next = await index.substructure(benzene, {
      limit: 24,
      budgetMs: 1500,
    });

    expect(performance.now() - started).toBeLessThanOrEqual(1500 + SLACK_MS);
    expect(next.hits).toStrictEqual(reference.hits);

    const v16 = added[0] as { id: number; key: number };
    started = performance.now();
    const seek = await index.substructure(V16_QUERY, {
      limit: 24,
      budgetMs: 1000,
      keyMin: v16.key,
    });

    expect(performance.now() - started).toBeLessThanOrEqual(1000 + SLACK_MS);
    expect(seek.hits.map((hit) => hit.id)).toStrictEqual([v16.id]);
  } finally {
    await index.close();
  }
}, 60_000);

test('short kill limits: the poor candidates end unverified and left out, the walk reaches V16, and the query skips them later', async () => {
  const index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    follow: false,
    verifyChunkMinMs: 300,
    verifySingleMs: 300,
  });
  try {
    const v16 = added[0] as { id: number; key: number };
    const first = await index.substructure(V16_QUERY, {
      limit: 24,
      budgetMs: 4500,
    });

    expect(first.partial).toBe(false);
    expect(first.hits.map((hit) => hit.id)).toStrictEqual([v16.id]);
    expect(first.unverified).toBe(3);
    expect(first.info.kills).toBeGreaterThanOrEqual(4);

    const again = await index.substructure(V16_QUERY, {
      limit: 24,
      budgetMs: 4500,
    });

    expect(again.hits).toStrictEqual(first.hits);
    expect(again.unverified).toBe(3);
    expect(again.info.kills).toBe(0);

    const one = await index.substructure(V16_QUERY, {
      limit: 1,
      budgetMs: 4500,
    });

    expect(one.hits.map((hit) => hit.id)).toStrictEqual([v16.id]);
  } finally {
    await index.close();
  }
}, 60_000);
