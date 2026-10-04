import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import { generatedLibrary } from '../../planes/__tests__/fixture.ts';
import { buildSSPrefilter } from '../buildSSPrefilter.ts';
import { packSSIndex } from '../packSSIndex.ts';
import type { PrefilterPlan } from '../prefilterPlan.ts';
import {
  ENTRY_ID_BOUNDS_SQL,
  guessedPrefilterPlan,
  measurePrefilterPlan,
  samplePasses,
} from '../prefilterPlan.ts';
import { prescreenColumn } from '../prescreenColumn.ts';
import { buildPrescreenSql } from '../prescreenSql.ts';
import type { PrescreenState } from '../prescreenTypes.ts';
import { installScanDeadline } from '../scanDeadline.ts';

const IDCODES = generatedLibrary(3000);

/**
 * Entries 1 … 3000 of the generated library.
 * @returns The connection.
 */
function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
  });
  molDB.migrate();
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code) VALUES (?, ?)',
  );
  for (const [index, idCode] of IDCODES.entries()) {
    insert.run(index + 1, idCode);
    molDB.insert(index + 1, idCode);
  }
  return db;
}

/**
 * A fragment's fingerprint.
 * @param smiles - The fragment.
 * @returns The molecule and its fingerprint.
 */
function fragment(smiles: string) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  return { mol, index: mol.getIndex() };
}

test('the prefilter tests only the words the query sets', () => {
  const { index } = fragment('c1ccccc1');
  const prefilter = buildSSPrefilter(index);
  const packed = packSSIndex(index);
  const set = packed.flatMap((word, column) => (word === 0n ? [] : [column]));

  expect(prefilter.terms).toHaveLength(set.length);
  expect(prefilter.terms.length).toBeLessThan(8);
  expect(prefilter.sql).not.toContain(`ss_index${packed.indexOf(0n)} `);
  expect(buildSSPrefilter(new Array(16).fill(0))).toStrictEqual({
    sql: '1',
    params: [],
    terms: [],
  });
});

test('a scan starts with the words setting most bits first, the guard first', () => {
  const { index } = fragment('O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12');
  const plan = guessedPrefilterPlan(index);
  const packed = packSSIndex(index);
  const bits = plan.words.map(
    (word) =>
      BigInt.asUintN(64, packed[word] ?? 0n)
        .toString(2)
        .replaceAll('0', '').length,
  );

  expect(plan).toMatchObject({
    guardAfter: 0,
    guardMask: 1023,
    measured: false,
  });
  expect(plan.words).toHaveLength(8);
  expect(bits).toStrictEqual(bits.toSorted((a, b) => b - a));
});

test('measured on its rows, the most selective word comes first, the guard after it', () => {
  const db = library();
  const { index } = fragment('FC(F)(F)c1ccccc1');
  const plan = measurePrefilterPlan(db, index, {});
  const sample = samplePasses(db, index, {});
  const counts = plan.words.map((word) => sample.get(word) ?? 0);
  const first = counts[0] as number;

  // 32 runs of 64 rows, spread over the library by entry id; the runs that
  // start among the heaviest entries reach the end of the index first.
  expect(sample.rows).toBe(2015);
  expect(counts).toStrictEqual(counts.toSorted((a, b) => a - b));
  expect(first).toBeGreaterThanOrEqual(4);
  expect(plan.guardAfter).toBe(1);
  expect(plan.measured).toBe(true);

  // About one clock read per 1024 rows: a power of two near 1024 × rate.
  let reaching = 1;
  while (reaching * 2 <= (1024 * first) / sample.rows) reaching *= 2;

  expect(plan.guardMask).toBe(reaching - 1);
});

test('a word no row of the sample passes keeps the guard first', () => {
  const db = library();
  // No generated molecule holds selenium.
  const { index } = fragment('c1ccc2c(c1)[se]c1ccccc12');
  const plan = measurePrefilterPlan(db, index, {});

  expect(plan).toMatchObject({
    guardAfter: 0,
    guardMask: 1023,
    measured: true,
  });
});

test('a planned scan writes its words in order, the guard after the first, and still seeks', () => {
  const db = library();
  const { mol, index } = fragment('FC(F)(F)c1ccccc1');
  const plan: PrefilterPlan = {
    words: guessedPrefilterPlan(index).words.toReversed(),
    guardAfter: 1,
    guardMask: 15,
    measured: true,
  };
  const query = buildPrescreenSql({
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
    mwFloor: 100,
    deadline: 1,
    guardKey: 7,
    plan,
  });
  const where = query.sql.slice(query.sql.indexOf('WHERE') + 6);
  const firstWord = plan.words[0] as number;

  expect(
    where.startsWith(
      `(s.ss_index${firstWord} & ?) = ? AND ((s.entry_id & 15) <> 0 OR ocl_ss_deadline(?, ?, s.mw, s.entry_id))`,
    ),
  ).toBe(true);
  expect(query.params.slice(2, 4)).toStrictEqual([1, 7]);

  installScanDeadline(db);
  const plan0 = (
    db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...(query.params as never[])) as Array<{ detail: string }>
  ).map((row) => row.detail);

  expect(plan0[0]).toBe('SEARCH s USING PRIMARY KEY (mw>?)');
});

test('a scan that measures its plan yields what a guessing one yields, in order', () => {
  const db = library();
  for (const smiles of ['c1ccncc1', 'FC(F)(F)c1ccccc1', 'C1CCNCC1']) {
    const { mol } = fragment(smiles);
    const params = {
      db,
      entriesTable: 'molecules',
      pkColumn: 'id',
      idCodeColumn: 'id_code',
      mol,
      timeoutMs: 60_000,
      maxCandidates: Number.MAX_SAFE_INTEGER,
    };
    const guessed: PrescreenState = { screened: 0, partial: false };
    const measured: PrescreenState = {
      screened: 0,
      partial: false,
      prefilterPlan: measurePrefilterPlan(db, mol.getIndex(), {}),
    };

    expect(
      [...prescreenColumn(params, measured)].map((c) => c.entryId),
    ).toStrictEqual(
      [...prescreenColumn(params, guessed)].map((c) => c.entryId),
    );
  }
});

test('a guard after the first word still stops a scan on time', () => {
  const db = library();
  const { mol } = fragment('FC(F)(F)c1ccccc1');
  const state: PrescreenState = {
    screened: 0,
    partial: false,
    prefilterPlan: {
      ...guessedPrefilterPlan(mol.getIndex()),
      guardAfter: 1,
      guardMask: 0,
      measured: true,
    },
  };
  const yielded = [
    ...prescreenColumn(
      {
        db,
        entriesTable: 'molecules',
        pkColumn: 'id',
        idCodeColumn: 'id_code',
        mol,
        timeoutMs: -1,
        maxCandidates: Number.MAX_SAFE_INTEGER,
      },
      state,
    ),
  ];

  expect(yielded).toStrictEqual([]);
  expect([state.partial, state.timedOut]).toStrictEqual([true, true]);
});

test('the entry id bounds a sample is spread over are two seeks, not a walk', () => {
  const db = library();
  const plan = (
    db.prepare(`EXPLAIN QUERY PLAN ${ENTRY_ID_BOUNDS_SQL}`).all() as Array<{
      detail: string;
    }>
  ).map((row) => row.detail);

  expect(plan.filter((detail) => detail.startsWith('SCAN'))).toStrictEqual([
    'SCAN CONSTANT ROW',
  ]);
  expect(plan.filter((detail) => detail.startsWith('SEARCH'))).toHaveLength(2);
  expect({
    ...(db.prepare(ENTRY_ID_BOUNDS_SQL).get() as object),
  }).toStrictEqual({
    low: 1,
    high: 3000,
  });
});
