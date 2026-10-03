// A/B: substructure searches on a folded plane index, against the same library never folded.
//
// One library, in several files: never folded; folded; folded with 1% of it inserted since, above
// the watermark, which every search screens through the entry index; and folded with 10% inserted
// since, which is more than the router accepts, so it goes back to the column scan. Each search
// runs end to end on one thread — prescreen and verification — with no result cache, and the
// totals are printed so the variants can be checked for the same answer.
//
//   node benchmark/foldedSearch.mjs [entries]
import { copyFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import { XSadd } from 'ml-xsadd';
import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';
import { packSSIndex } from '../src/utils/packSSIndex.ts';

import { syntheticPool } from './syntheticPool.mjs';

const ROWS = Number(process.argv[2] ?? 200_000);
const QUERIES = [
  ['naphthalene', 'c1ccc2ccccc2c1'],
  ['biphenyl-F', 'Fc1ccc(-c2ccccc2)cc1'],
  ['benzamide', 'O=C(N)c1ccccc1'],
  ['sulfonamide-aryl', 'NS(=O)(=O)c1ccccc1'],
  ['thiophene-amide', 'O=C(N)c1cccs1'],
  ['benzene', 'c1ccccc1'],
];
const CONFIG = { entriesTable: 'molecules', poolSize: 1, searchCacheSize: 0 };

const library = syntheticPool();
const { random } = new XSadd(2026);
const picks = new Array(ROWS + ROWS / 10);
for (let i = 0; i < picks.length; i++) {
  picks[i] = library[Math.floor(random() * library.length)];
}

function fileOf(name) {
  const file = `/tmp/foldedSearch-${name}.sqlite`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  return file;
}

function append(db, from, to) {
  const entry = db.prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)');
  const index = db.prepare(
    `INSERT INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2,
       ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec('BEGIN');
  for (let i = from; i < to; i++) {
    const pick = picks[i];
    entry.run(i + 1, pick.idCode);
    index.run(pick.mw, i + 1, ...packSSIndex(pick.index));
  }
  db.exec('COMMIT');
}

const base = fileOf('unfolded');
{
  const db = new DatabaseSync(base);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)');
  new MoleculesDBSQLite(db, OCL, CONFIG).migrate();
  append(db, 0, ROWS);
  db.close();
}

function variant(name, inserted) {
  if (name === 'unfolded') return new DatabaseSync(base);
  const file = fileOf(name);
  copyFileSync(base, file);
  const db = new DatabaseSync(file);
  const molDB = new MoleculesDBSQLite(db, OCL, CONFIG);
  const started = performance.now();
  molDB.foldPlanes();
  console.log(`${name}: folded ${ROWS} entries in ${(performance.now() - started).toFixed(0)} ms`);
  append(db, ROWS, ROWS + inserted);
  return db;
}

const variants = Object.entries({
  unfolded: 0,
  folded: 0,
  'folded + 1% above the watermark': ROWS / 100,
  'folded + 10% above the watermark': ROWS / 10,
}).map(([name, inserted]) => {
  const db = variant(name, inserted);
  return { name, molDB: new MoleculesDBSQLite(db, OCL, CONFIG) };
});
for (const { name, molDB } of variants) {
  console.log(`${name.padEnd(34)} ${JSON.stringify(molDB.planeStatus())}`);
}

for (const [label, smiles] of QUERIES) {
  const suite = new Benchmark.Suite();
  const totals = new Map();
  for (const { name, molDB } of variants) {
    suite.add(`${label} ${name}`, {
      defer: true,
      minSamples: 30,
      fn(deferred) {
        molDB
          .search(smiles, { mode: 'substructure', timeoutMs: 600_000 })
          .then((response) => {
            totals.set(name, response.total);
            deferred.resolve();
          });
      },
    });
  }
  await new Promise((resolve) => {
    suite
      .on('cycle', (event) => {
        const { name, stats } = event.target;
        const variantName = name.slice(label.length + 1);
        console.log(
          `${label.padEnd(17)} ${variantName.padEnd(34)} ${(stats.mean * 1000).toFixed(2).padStart(9)} ms  ` +
            `±${stats.rme.toFixed(1)}%  ${totals.get(variantName)} matches`,
        );
      })
      .on('complete', resolve)
      .run({ async: true });
  });
}
for (const { molDB } of variants) await molDB.close();
