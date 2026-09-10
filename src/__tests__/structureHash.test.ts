import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { hashIdCode } from '../hashWorker.ts';
import type { BackfillProgress } from '../types.ts';

// Two pairs that isolate one thing each: the enantiomers differ only in stereo,
// the keto/enol pair only in tautomer form.
const L_ALANINE = 'N[C@@H](C)C(=O)O';
const D_ALANINE = 'N[C@H](C)C(=O)O';
const KETO = 'CC(=O)CC(=O)C';
const ENOL = 'CC(O)=CC(=O)C';

/**
 * A database holding the given molecules, indexed but not yet hashed.
 * @param smilesList - The molecules to insert, as SMILES.
 * @returns The connection and the configured instance.
 */
function makeDB(smilesList: string[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 2,
  });
  molDB.migrate();
  const insert = db.prepare('INSERT INTO molecules (id_code) VALUES (?)');
  for (const smiles of smilesList) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    const { lastInsertRowid } = insert.run(idCode);
    molDB.insert(Number(lastInsertRowid), idCode);
  }
  return { db, molDB };
}

const idCodeOf = (smiles: string) =>
  OCL.Molecule.fromSmiles(smiles).getIDCode();

const noStereo = (smiles: string) => hashIdCode('noStereo', idCodeOf(smiles));
const noStereoTautomer = (smiles: string) =>
  hashIdCode('noStereoTautomer', idCodeOf(smiles));

test('the no-stereo hash ignores stereo but keeps tautomers apart', () => {
  expect(noStereo(L_ALANINE)).toBe(noStereo(D_ALANINE));
  expect(noStereo(KETO)).not.toBe(noStereo(ENOL));
});

test('the no-stereo tautomer hash merges tautomers too', () => {
  expect(noStereoTautomer(L_ALANINE)).toBe(noStereoTautomer(D_ALANINE));
  expect(noStereoTautomer(KETO)).toBe(noStereoTautomer(ENOL));
  expect(noStereoTautomer(KETO)).not.toBe(noStereoTautomer(L_ALANINE));
});

test('an idCode with no hash gives null rather than throwing', () => {
  // OCL returns NO_HASH for one it cannot parse and throws on a malformed one;
  // both are the same answer here, for both kinds.
  for (const kind of ['noStereo', 'noStereoTautomer'] as const) {
    expect(hashIdCode(kind, '')).toBeNull();
    expect(hashIdCode(kind, '!!not-an-idcode')).toBeNull();
  }
});

test('one idCode query, three modes, each broader than the last', async () => {
  const { molDB } = makeDB([L_ALANINE, D_ALANINE, KETO, ENOL]);
  await molDB.backfillHashes();

  const search = (
    smiles: string,
    mode: 'exact' | 'exactNoStereo' | 'exactNoStereoTautomer',
  ) => molDB.search(idCodeOf(smiles), { mode, format: 'idCode' });

  const alanine = await Promise.all([
    search(L_ALANINE, 'exact'),
    search(L_ALANINE, 'exactNoStereo'),
    search(L_ALANINE, 'exactNoStereoTautomer'),
  ]);

  expect(alanine.map((r) => r.results.map((e) => e.entryId))).toStrictEqual([
    [1],
    [1, 2],
    [1, 2],
  ]);

  const keto = await Promise.all([
    search(KETO, 'exact'),
    search(KETO, 'exactNoStereo'),
    search(KETO, 'exactNoStereoTautomer'),
  ]);

  // Stereo does not help the keto/enol pair; only the tautomer hash joins them.
  expect(keto.map((r) => r.results.map((e) => e.entryId))).toStrictEqual([
    [3],
    [3],
    [3, 4],
  ]);

  await molDB.close();
});

test('neither hash mode finds anything before the backfill has run', async () => {
  const { molDB } = makeDB([L_ALANINE, D_ALANINE]);

  const responses = await Promise.all(
    (['exactNoStereo', 'exactNoStereoTautomer'] as const).map((mode) =>
      molDB.search(L_ALANINE, { mode }),
    ),
  );

  for (const { total } of responses) {
    expect(total).toBe(0);
  }

  await molDB.close();
});

test('the backfill runs the cheap pass first, then the expensive one', async () => {
  const { molDB } = makeDB([L_ALANINE, D_ALANINE, KETO]);
  const result = await molDB.backfillHashes();

  expect(result.passes.map((pass) => pass.kind)).toStrictEqual([
    'noStereo',
    'noStereoTautomer',
  ]);
  // Three entries, both hashes each.
  expect(result.hashed).toBe(6);
  expect(result.noHash).toBe(0);
  expect(result.timedOut).toBe(0);
  expect(result.remaining).toBe(0);

  for (const pass of result.passes) {
    expect(pass.hashed).toBe(3);
    expect(pass.remaining).toBe(0);
  }

  await molDB.close();
});

test('a query OCL cannot hash matches nothing, in both modes', async () => {
  const { molDB } = makeDB([KETO]);
  await molDB.backfillHashes();

  const responses = await Promise.all(
    (['exactNoStereo', 'exactNoStereoTautomer'] as const).flatMap((mode) =>
      ['', '!!not-an-idcode'].map((query) =>
        molDB.search(query, { mode, format: 'idCode' }),
      ),
    ),
  );

  for (const { results, total } of responses) {
    expect(total).toBe(0);
    expect(results).toStrictEqual([]);
  }

  await molDB.close();
});

test('an entry with no usable idCode is stored as NULL and never retried', async () => {
  const { db, molDB } = makeDB([KETO]);
  db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(
    '!!not-an-idcode',
  );

  const first = await molDB.backfillHashes();

  expect(first.hashed).toBe(2);
  expect(first.noHash).toBe(2);
  expect(first.remaining).toBe(0);

  // The column holds real 64-bit values, so reading one back as a JS number
  // overflows: a caller querying these tables directly needs BigInt reads.
  for (const table of ['ocl_no_stereo_hash', 'ocl_no_stereo_tautomer_hash']) {
    const read = db.prepare(`SELECT hash FROM ${table} ORDER BY entry_id`);
    read.setReadBigInts(true);
    const rows = read.all() as Array<{ hash: bigint | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.hash).toStrictEqual(expect.any(BigInt));
    expect(rows[1]?.hash).toBeNull();
  }

  // The NULL is an answer, not a gap: a second run has nothing left to do.
  const second = await molDB.backfillHashes();

  expect(second.hashed).toBe(0);
  expect(second.noHash).toBe(0);
  expect(second.remaining).toBe(0);

  await molDB.close();
});

test('the backfill resumes where a bounded run stopped', async () => {
  const { db, molDB } = makeDB([L_ALANINE, D_ALANINE, KETO, ENOL, 'CCO']);

  // limit bounds each pass, so two entries get both hashes.
  const first = await molDB.backfillHashes({ limit: 2, chunkSize: 1 });

  expect(first.hashed).toBe(4);
  expect(first.remaining).toBe(6);

  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  expect(count('ocl_no_stereo_hash')).toBe(2);
  expect(count('ocl_no_stereo_tautomer_hash')).toBe(2);

  const second = await molDB.backfillHashes();

  expect(second.hashed).toBe(6);
  expect(second.remaining).toBe(0);
  expect(count('ocl_no_stereo_hash')).toBe(5);
  expect(count('ocl_no_stereo_tautomer_hash')).toBe(5);

  await molDB.close();
});

test('an aborted backfill keeps its committed chunks', async () => {
  const { molDB } = makeDB([L_ALANINE, D_ALANINE, KETO, ENOL]);
  const controller = new AbortController();
  const result = await molDB.backfillHashes({
    chunkSize: 1,
    onProgress: () => controller.abort(),
    signal: controller.signal,
  });

  // The abort is honoured at the next chunk boundary, so exactly the first
  // chunk of the first pass survives and the rest is left for a later run.
  expect(result.hashed).toBe(1);
  expect(result.passes).toHaveLength(1);
  expect(result.passes[0]?.kind).toBe('noStereo');

  const rest = await molDB.backfillHashes();

  expect(rest.hashed).toBe(7);
  expect(rest.remaining).toBe(0);

  await molDB.close();
});

test('progress is reported per pass, once per committed chunk', async () => {
  const { molDB } = makeDB([L_ALANINE, D_ALANINE, KETO, ENOL]);
  const progress: BackfillProgress[] = [];
  await molDB.backfillHashes({
    chunkSize: 2,
    onProgress: (event) => progress.push(event),
  });

  expect(
    progress.map((event) => `${event.kind}:${event.done}/${event.total}`),
  ).toStrictEqual([
    'noStereo:2/4',
    'noStereo:4/4',
    'noStereoTautomer:2/4',
    'noStereoTautomer:4/4',
  ]);

  await molDB.close();
});

test('backfilling an empty table does nothing', async () => {
  const { molDB } = makeDB([]);
  const result = await molDB.backfillHashes();

  expect(result.hashed).toBe(0);
  expect(result.remaining).toBe(0);
  expect(result.passes.map((pass) => pass.kind)).toStrictEqual([
    'noStereo',
    'noStereoTautomer',
  ]);

  await molDB.close();
});

test('a candidates subquery restricts a hash mode like every other', async () => {
  const { db, molDB } = makeDB([KETO, ENOL]);
  await molDB.backfillHashes();
  db.exec('ALTER TABLE molecules ADD COLUMN name TEXT');
  db.exec("UPDATE molecules SET name = 'keto' WHERE id = 1");

  const { results, total } = await molDB.search(KETO, {
    mode: 'exactNoStereoTautomer',
    candidates: {
      sql: 'SELECT id AS entry_id FROM molecules WHERE name = :name',
      params: { name: 'keto' },
    },
  });

  expect(total).toBe(1);
  expect(results.map((entry) => entry.entryId)).toStrictEqual([1]);

  await molDB.close();
});

// A real molecule from the wwPDB corpus whose generic tautomer takes OpenChemLib
// roughly 700 ms to canonize — three orders of magnitude past the median. The
// cap exists for this shape of molecule, so the test uses one rather than a
// contrived tiny cap that would race the fast path.
const PATHOLOGICAL =
  'eoTuJ@@BC@im`XQ]WPDAJf\\bfbRbfbbRRtRLQRbbQrffTR\\BJFqIm]Zjff`jAhjdJ@fjfhDcBRQj\\p@';

test('a molecule past the cap is given up on and stored as NULL', async () => {
  const { db, molDB } = makeDB([KETO]);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO molecules (id_code) VALUES (?)')
    .run(PATHOLOGICAL);
  const slowId = Number(lastInsertRowid);
  molDB.insert(slowId, PATHOLOGICAL);

  const started = Date.now();
  const result = await molDB.backfillHashes({ capMs: 100 });

  // Uncapped this molecule alone would take ~700 ms in the tautomer pass.
  expect(Date.now() - started).toBeLessThan(600);
  expect(result.timedOut).toBe(1);

  // The no-stereo pass is nowhere near the cap, so it hashed both entries.
  const noStereoPass = result.passes.find((pass) => pass.kind === 'noStereo');

  expect(noStereoPass?.hashed).toBe(2);
  expect(noStereoPass?.timedOut).toBe(0);

  const read = db.prepare(
    'SELECT hash FROM ocl_no_stereo_tautomer_hash WHERE entry_id = ?',
  );
  read.setReadBigInts(true);

  expect((read.get(slowId) as { hash: bigint | null }).hash).toBeNull();

  // The worker that was destroyed is replaced, so the run finished the rest.
  const { total } = await molDB.search(KETO, { mode: 'exactNoStereoTautomer' });

  expect(total).toBe(1);

  await molDB.close();
});
