// Substructure-scan benchmark on a real chemistry database.
//
// Reports the two numbers that matter for the search architecture:
//   1. how the scan scales with poolSize (does the pool actually parallelise?)
//   2. how much of the time is the prescreen vs the verification
//
// Usage:
//   node --experimental-strip-types benchmark/substructureScan.mjs <db.sqlite>
//
// The database must have an entries table `ligands (id, id_code, name, mw)` and
// a migrated ocl_ss_index. See benchmark/README.md for how to build one from the
// wwPDB Chemical Component Dictionary.
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';
import { buildSSPrefilter } from '../src/utils/buildSSPrefilter.ts';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  throw new Error('usage: substructureScan.mjs <db.sqlite>');
}

// A rare fragment: ~6k candidates survive the fingerprint prefilter and almost
// none of them match, so the scan runs to completion. An early-stopping common
// fragment would finish before the pool could show any difference.
const RARE_SMILES = 'c1ccc2nc3ccccc3nc2c1'; // phenazine

function openDB(poolSize) {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA mmap_size=2147418112');
  db.exec('PRAGMA cache_size=-131072');
  db.exec('PRAGMA temp_store=MEMORY');
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'ligands',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    poolSize,
    searchCacheSize: 0, // every timing must be a real scan, never a cache hit
  });
  return { db, molDB };
}

async function best(run, times = 3) {
  const measured = [];
  let last;
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    // eslint-disable-next-line no-await-in-loop -- intentional: measure one run at a time
    last = await run();
    measured.push(performance.now() - start);
  }
  return { ms: Math.min(...measured), last };
}

const fragment = OCL.Molecule.fromSmiles(RARE_SMILES);
fragment.setFragment(true);
const fragmentIdCode = fragment.getIDCode();

const probe = new DatabaseSync(DB_PATH);
const indexed = probe.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get().n;
probe.close();
console.log(`${indexed} indexed molecules | query: ${RARE_SMILES}\n`);

console.log('SCALING — full scan of a rare fragment');
console.log('  poolSize   wall-clock   speedup vs 1 thread');
let single = 0;
for (const poolSize of [1, 2, 4, 8]) {
  const { db, molDB } = openDB(poolSize);
  // eslint-disable-next-line no-await-in-loop -- intentional: one pool at a time
  await molDB.search(fragmentIdCode, { mode: 'substructure', format: 'idCode' });
  // eslint-disable-next-line no-await-in-loop -- intentional: one pool at a time
  const run = await best(() =>
    molDB.search(fragmentIdCode, { mode: 'substructure', format: 'idCode' }),
  );
  if (poolSize === 1) single = run.ms;
  console.log(
    `  ${String(poolSize).padStart(4)}     ${run.ms.toFixed(0).padStart(7)} ms   ` +
      `${(single / run.ms).toFixed(2)}x   (matches=${run.last.total} screened=${run.last.screened})`,
  );
  // eslint-disable-next-line no-await-in-loop -- intentional: one pool at a time
  await molDB.close();
  db.close();
}

console.log('\nPHASES — where the time goes (single thread)');
const phaseDb = new DatabaseSync(DB_PATH);
phaseDb.exec('PRAGMA mmap_size=2147418112');
const prefilter = buildSSPrefilter(fragment.getIndex());
const scan = phaseDb.prepare(
  `SELECT s.entry_id, s.mw, e.id_code FROM ocl_ss_index s
   JOIN ligands e ON e.id = s.entry_id WHERE ${prefilter.sql}`,
);
const prescreenRun = await best(() => {
  let n = 0;
  for (const _row of scan.iterate(...prefilter.params)) n++;
  return Promise.resolve(n);
});
const { molDB, db } = openDB(1);
const fullRun = await best(() =>
  molDB.search(fragmentIdCode, { mode: 'substructure', format: 'idCode' }),
);
await molDB.close();
db.close();
phaseDb.close();

const verifyMs = fullRun.ms - prescreenRun.ms;
console.log(`  prescreen (SQL + fingerprint) : ${prescreenRun.ms.toFixed(0).padStart(5)} ms  (${((prescreenRun.ms / fullRun.ms) * 100).toFixed(1)}%)`);
console.log(`  verify (parse + graph match)  : ${verifyMs.toFixed(0).padStart(5)} ms  (${((verifyMs / fullRun.ms) * 100).toFixed(1)}%)`);
console.log(`  candidates prescreened        : ${prescreenRun.last}`);
