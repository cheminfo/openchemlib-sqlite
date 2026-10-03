// Prescreen: the transposed plane index against the ss_index column scan.
//
// Real molecules, synthetic library: ~8700 fingerprints are computed from
// combinatorial SMILES and then sampled with replacement, so bit marginals AND
// bit correlations are those of real structures (a synthetic fingerprint drawn
// bit by bit is independent, which makes every multi-bit query return nothing).
// What is measured is the prescreen only — verification is unchanged.
//
//   node benchmark/planeScan.mjs [rows] [dbfile]

import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

import { XSadd } from 'ml-xsadd';
import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/MoleculesDBSQLite.ts';
import { foldPlanes } from '../src/planes/foldPlanes.ts';
import { readFoldState } from '../src/planes/foldState.ts';
import {
  planeChunks,
  planeCoverage,
  planeQueryBits,
  planeSurvivorCount,
} from '../src/planes/planeCoverage.ts';
import { prescreenPlanes } from '../src/planes/planePrescreen.ts';
import { choosePrescreenPath } from '../src/planes/planeRouter.ts';
import { prescreen } from '../src/utils/prescreen.ts';
import { packSSIndex } from '../src/utils/packSSIndex.ts';
import { buildPrescreenSql } from '../src/utils/prescreen.ts';

import { syntheticPool as pool } from './syntheticPool.mjs';

const ROWS = Number(process.argv[2] ?? 2_000_000);
const FILE = process.argv[3] ?? '/tmp/planeScan.sqlite';

const QUERIES = [
  ['benzene', 'c1ccccc1'],
  ['phenol', 'Oc1ccccc1'],
  ['naphthalene', 'c1ccc2ccccc2c1'],
  ['biphenyl-F', 'Fc1ccc(-c2ccccc2)cc1'],
  ['benzamide', 'O=C(N)c1ccccc1'],
  ['sulfonamide-aryl', 'NS(=O)(=O)c1ccccc1'],
];

function seed() {
  rmSync(FILE, { force: true });
  rmSync(`${FILE}-wal`, { force: true });
  const db = new DatabaseSync(FILE);
  for (const pragma of ['journal_mode = WAL', 'synchronous = OFF',
    'cache_size = -131072', 'temp_store = MEMORY']) {
    db.exec(`PRAGMA ${pragma}`);
  }
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'molecules' });
  molDB.migrate();

  const t0 = performance.now();
  const library = pool();
  console.log(
    `pool: ${library.length} real fingerprints in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );

  const { random } = new XSadd(2026);
  const picks = new Array(ROWS);
  for (let i = 0; i < ROWS; i++) {
    picks[i] = library[Math.floor(random() * library.length)];
  }
  // Inserted in mw order so the mw-clustered table is appended to rather than
  // written into the middle of, which is the difference between minutes and
  // hours at this size.
  picks.sort((a, b) => a.mw - b.mw);

  const t1 = performance.now();
  const entry = db.prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)');
  const screen = db.prepare(
    `INSERT INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2,
       ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < ROWS; i++) {
    const pick = picks[i];
    entry.run(i + 1, pick.idCode);
    screen.run(pick.mw, i + 1, ...packSSIndex(pick.index));
    if (i % 200_000 === 199_999) {
      db.exec('COMMIT');
      db.exec('BEGIN');
    }
  }
  db.exec('COMMIT');
  console.log(
    `seeded ${ROWS} rows in ${((performance.now() - t1) / 1000).toFixed(1)} s`,
  );
  return { db, molDB };
}

// What a real search runs: the dispatcher, which routes per query.
function routedScan(db, mol) {
  const state = { screened: 0, partial: false };
  let count = 0;
  for (const _c of prescreen(
    {
      db, entriesTable: 'molecules', pkColumn: 'id', idCodeColumn: 'id_code',
      mol, timeoutMs: 600_000, maxCandidates: Number.MAX_SAFE_INTEGER,
      maxResults: Number.MAX_SAFE_INTEGER,
    },
    state,
  )) {
    count++;
  }
  return { count, usedPlaneIndex: state.usedPlaneIndex === true };
}

// The old behaviour: the same dispatcher with the plane index switched off, so
// the only difference from `routedScan` is the routing itself. Counting raw rows
// instead would flatter it — a real search builds a candidate object per row.
function columnScan(db, mol) {
  const state = { screened: 0, partial: false };
  let count = 0;
  for (const _c of prescreen(
    {
      db, entriesTable: 'molecules', pkColumn: 'id', idCodeColumn: 'id_code',
      mol, timeoutMs: 600_000, maxCandidates: Number.MAX_SAFE_INTEGER,
      maxResults: Number.MAX_SAFE_INTEGER, planeIndex: false,
    },
    state,
  )) {
    count++;
  }
  return count;
}

function planeScan(db, mol, bits) {
  const state = { screened: 0, partial: false };
  let count = 0;
  for (const _candidate of prescreenPlanes(
    {
      db, entriesTable: 'molecules', pkColumn: 'id', idCodeColumn: 'id_code',
      mol, timeoutMs: 600_000, maxCandidates: Number.MAX_SAFE_INTEGER,
    },
    state,
    bits,
    readFoldState(db).watermark,
  )) {
    count++;
  }
  return count;
}

const { db } = seed();

const tFold = performance.now();
let folded = 0;
let result;
do {
  result = foldPlanes(db, { maxPopulationRatio: 0.5 });
  folded += result.folded;
} while (result.pending && result.folded > 0);
console.log(
  `folded ${folded} entries into ${planeChunks(db).length} chunks, ` +
    `${result.storedBits}/512 bits stored, ` +
    `${((performance.now() - tFold) / 1000).toFixed(1)} s ` +
    `(${JSON.stringify(planeCoverage(db))})`,
);

const sizes = db
  .prepare(
    `SELECT name, SUM(pgsize) AS bytes FROM dbstat
      WHERE name IN ('ocl_ss_index','ssIndex','ocl_ss_plane','ocl_ss_slot')
      GROUP BY name`,
  )
  .all();
for (const row of sizes) {
  console.log(`  ${row.name}: ${(Number(row.bytes) / 1e6).toFixed(1)} MB`);
}

console.log(
  `\n${'query'.padEnd(18)}${'bits'.padStart(5)}${'used'.padStart(6)}` +
    `${'column ms'.padStart(11)}${'screen ms'.padStart(11)}` +
    `${'plane ms'.padStart(10)}${'routed ms'.padStart(11)}${'path'.padStart(8)}` +
    `${'speedup'.padStart(9)}${'candidates'.padStart(12)}`,
);
for (const [name, smiles] of QUERIES) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  const total = [...mol.getIndex()].reduce((n, w) => {
    let x = w >>> 0, c = 0;
    while (x) { x &= x - 1; c++; }
    return n + c;
  }, 0);
  const bits = planeQueryBits(db, mol.getIndex());

  let best = Infinity;
  let columnCount = 0;
  for (let pass = 0; pass < 3; pass++) {
    const t = performance.now();
    columnCount = columnScan(db, mol);
    best = Math.min(best, performance.now() - t);
  }

  let screenBest = Infinity;
  let planeBest = Infinity;
  let planeCount = 0;
  if (bits !== null) {
    for (let pass = 0; pass < 3; pass++) {
      const t = performance.now();
      planeSurvivorCount(db, bits);
      screenBest = Math.min(screenBest, performance.now() - t);
    }
    for (let pass = 0; pass < 3; pass++) {
      const t = performance.now();
      planeCount = planeScan(db, mol, bits);
      planeBest = Math.min(planeBest, performance.now() - t);
    }
    if (planeCount !== columnCount) {
      throw new Error(
        `${name}: plane path found ${planeCount}, column path ${columnCount}`,
      );
    }
  }

  let routedBest = Infinity;
  let routed = { count: 0, usedPlaneIndex: false };
  for (let pass = 0; pass < 3; pass++) {
    const t = performance.now();
    routed = routedScan(db, mol);
    routedBest = Math.min(routedBest, performance.now() - t);
  }
  if (routed.count !== columnCount) {
    throw new Error(`${name}: routed found ${routed.count}, column ${columnCount}`);
  }

  console.log(
    name.padEnd(18) +
      String(total).padStart(5) +
      String(bits?.length ?? 0).padStart(6) +
      best.toFixed(0).padStart(11) +
      (bits === null ? '-' : screenBest.toFixed(0)).padStart(11) +
      (bits === null ? 'declined' : planeBest.toFixed(0)).padStart(10) +
      routedBest.toFixed(0).padStart(11) +
      (routed.usedPlaneIndex ? 'plane' : 'column').padStart(8) +
      `${(best / routedBest).toFixed(1)}x`.padStart(9) +
      String(columnCount).padStart(12),
  );
}
db.close();
