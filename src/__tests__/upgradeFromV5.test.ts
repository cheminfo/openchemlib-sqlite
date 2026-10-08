import type { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import type { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { emptyLibrary, generatedLibrary } from '../planes/__tests__/fixture.ts';
import { TAIL_TABLE, buildPlaneSchemaSqlV5 } from '../planes/planeSchema.ts';
import { WATERMARK_TRIGGERS } from '../planes/watermarkSchema.ts';
import { STALE_BITS_TRIGGER } from '../utils/bitsColumn.ts';
import { BITS_COLUMN, COLUMNS_TABLE } from '../utils/indexColumns.ts';

const IDCODES = generatedLibrary(120);
const SIMILAR = ['c1ccncc1C(=O)N', 'Oc1ccc(Cl)cc1', 'C1CCNCC1C#N'];

/**
 * A library of the generated molecules, never folded.
 * @returns The connection and the molecules DB.
 */
function library() {
  const { db, molDB } = emptyLibrary();
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code) VALUES (?, ?)',
  );
  for (const [index, idCode] of IDCODES.entries()) {
    insert.run(index + 1, idCode);
    molDB.insert(index + 1, idCode);
  }
  return { db, molDB };
}

/**
 * Turn a database back into exactly what openchemlib-sqlite 5.2.0 left: schema
 * version 5 with its tail holding every entry, and none of what version 6 and
 * the bit counts added — no fold table, no columns record, no `ss_bits`
 * column and no trigger.
 * @param db - The connection.
 */
function rewindToRelease520(db: DatabaseSync) {
  for (const trigger of [...WATERMARK_TRIGGERS, STALE_BITS_TRIGGER]) {
    db.exec(`DROP TRIGGER ${trigger}`);
  }
  db.exec('DROP TABLE ocl_ss_fold');
  db.exec(`DROP TABLE ${COLUMNS_TABLE}`);
  db.exec(`ALTER TABLE ocl_ss_index DROP COLUMN ${BITS_COLUMN}`);
  db.exec('DELETE FROM ocl_ss_schema WHERE version > 5');
  db.exec(buildPlaneSchemaSqlV5({ entriesTable: 'molecules', pkColumn: 'id' }));
  db.exec(`INSERT INTO ${TAIL_TABLE} SELECT * FROM ocl_ss_index`);
}

/**
 * The answers of a few similarity searches and one substructure search.
 * @param molDB - The index.
 * @returns The entry ids, and the coefficients of the similarity matches.
 */
async function answers(molDB: MoleculesDBSQLite) {
  const all: unknown[] = [];
  for (const smiles of SIMILAR) {
    // eslint-disable-next-line no-await-in-loop -- compared one at a time
    const response = await molDB.search(smiles, {
      mode: 'similarity',
      similarityThreshold: 0.4,
    });
    all.push(response.results.map((hit) => [hit.entryId, hit.similarity]));
  }
  const response = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    maxResults: 1000,
  });
  all.push(
    response.results.map((hit) => hit.entryId).toSorted((a, b) => a - b),
  );
  return all;
}

/**
 * The names of the triggers on the index.
 * @param db - The connection.
 * @returns Them, sorted.
 */
function triggers(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

test('a 5.2.0 database gains the bit counts on upgrade, and answers the same', async () => {
  const { db, molDB } = library();
  const expected = await answers(molDB);
  rewindToRelease520(db);

  expect(expected.map((hits) => (hits as unknown[]).length)).toStrictEqual([
    7, 7, 12, 48,
  ]);
  expect(triggers(db)).toStrictEqual(['ocl_ss_tail_insert']);
  expect(molDB.migrate()).toStrictEqual([6]);
  expect(triggers(db)).toStrictEqual([
    STALE_BITS_TRIGGER,
    ...WATERMARK_TRIGGERS.toSorted(),
  ]);
  expect(molDB.columnStatus()).toStrictEqual([
    {
      name: BITS_COLUMN,
      type: 'integer',
      declared: true,
      complete: false,
      filledThrough: 0,
      fillTo: IDCODES.length,
    },
  ]);
  // Every count is unknown, so every row is computed.
  await expect(answers(molDB)).resolves.toStrictEqual(expected);

  const fill = await molDB.fillColumns();

  expect([fill.filled, fill.pending]).toStrictEqual([IDCODES.length, false]);
  expect(molDB.columnStatus()[0]?.complete).toBe(true);

  const nulls = db
    .prepare(
      `SELECT count(*) AS n FROM ocl_ss_index WHERE ${BITS_COLUMN} IS NULL`,
    )
    .get() as { n: number };

  expect(nulls.n).toBe(0);
  await expect(answers(molDB)).resolves.toStrictEqual(expected);
  expect(molDB.foldPlanes()).toMatchObject({
    folded: IDCODES.length,
    pending: false,
  });
  await expect(answers(molDB)).resolves.toStrictEqual(expected);
});
