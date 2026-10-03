// A/B: writing a precomputed fingerprint with a statement prepared for every insert, against the
// same insert through a statement prepared once.
//
// Both implementations are copied into this file and run in one process on the same rows. A is
// what `insert()` did with a precomputed entry: `prepare()` then `run()`, every call. B keeps the
// prepared statement. Preparing is most of what such an insert costs once the fingerprint is in
// hand, and an index is filled from millions of them.
//
// A hundred samples each: a statement prepared per insert leaves garbage behind, and its timing
// varies with the collector, which thirty samples left at ±15%.
//
// Usage:
//   node --experimental-strip-types benchmark/insertPrecomputed.mjs [entries]
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';

const ENTRIES = Number(process.argv[2] ?? 20_000);
const SQL =
  'INSERT OR REPLACE INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// A real schema, tail trigger included, so each insert writes what the library writes.
const db = new DatabaseSync(':memory:');
db.exec(
  'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
);
new MoleculesDBSQLite(db, OCL, {
  entriesTable: 'molecules',
  poolSize: 1,
}).migrate();
// The fingerprint table references its entries, and node:sqlite enforces it.
const entry = db.prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)');
for (let id = 1; id <= ENTRIES; id++) entry.run(id, `entry ${id}`);

// Fingerprints of a few real molecules, spread over the entries.
const fingerprints = [
  'c1ccccc1',
  'CCO',
  'O=c1cc(-c2ccccc2)oc2ccccc12',
  'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
].map((smiles) =>
  Array.from(
    new BigInt64Array(
      new Int32Array(OCL.Molecule.fromSmiles(smiles).getIndex()).buffer,
    ),
  ),
);

// --- A: prepared for every insert (the previous #insertIndexRow) ---
function insertPreparingEach() {
  db.exec('BEGIN');
  for (let id = 1; id <= ENTRIES; id++) {
    db.prepare(SQL).run(
      100 + (id % 400),
      id,
      ...fingerprints[id % fingerprints.length],
    );
  }
  db.exec('COMMIT');
  return ENTRIES;
}

// --- B: prepared once ---
let statement;
function insertPreparedOnce() {
  statement ??= db.prepare(SQL);
  db.exec('BEGIN');
  for (let id = 1; id <= ENTRIES; id++) {
    statement.run(
      100 + (id % 400),
      id,
      ...fingerprints[id % fingerprints.length],
    );
  }
  db.exec('COMMIT');
  return ENTRIES;
}

const a = insertPreparingEach();
const rowsA = db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get().n;
const b = insertPreparedOnce();
const rowsB = db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get().n;
console.log(
  `${ENTRIES} entries a run; rows written: ${a} then ${b}, index holds ${rowsA} then ${rowsB}\n`,
);

new Benchmark.Suite()
  .add('prepared for every insert', insertPreparingEach, { minSamples: 100 })
  .add('prepared once', insertPreparedOnce, { minSamples: 100 })
  .on('cycle', (event) => {
    const { name, stats, hz } = event.target;
    console.log(
      `  ${name.padEnd(26)} ${(1000 / hz).toFixed(0).padStart(6)} ms/run  ` +
        `${(1e9 / hz / ENTRIES).toFixed(0).padStart(6)} ns/entry  ±${stats.rme.toFixed(1)}%  (${stats.sample.length} runs)`,
    );
  })
  .on('complete', function onComplete() {
    const [each, once] = this.map((bench) => bench.hz);
    console.log(`  → prepared once is ${(once / each).toFixed(2)}x\n`);
  })
  .run();
