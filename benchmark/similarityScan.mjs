// A/B: a similarity scan computing the Tanimoto coefficient in JavaScript, row by row, against the
// same scan computing it inside SQLite with the threshold in the WHERE clause.
//
// Both implementations are copied into this file and run in one process on the same database, so
// the numbers are comparable. A is what `#scanSimilarityFull` did: every row is handed over — the
// entry id, the idCode and the eight fingerprint columns as BigInts — unpacked into a fresh array
// and compared with `SSSearcherWithIndex.getSimilarityTanimoto()`. B registers the coefficient as
// a SQL function, so only the rows that reach the threshold leave SQLite.
//
// Usage:
//   node --experimental-strip-types benchmark/similarityScan.mjs <db.sqlite> [entriesTable] [pkColumn] [idCodeColumn]
//
// Any database the library built works, e.g. one from seedIdCodes.mjs, or a collection index of
// molecules.cheminfo.org (`collection_members id idCode`).
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

const [FILE, TABLE = 'ligands', PK = 'id', ID_CODE = 'id_code'] =
  process.argv.slice(2);
if (!FILE) {
  throw new Error(
    'usage: similarityScan.mjs <db.sqlite> [entriesTable] [pkColumn] [idCodeColumn]',
  );
}

const db = new DatabaseSync(FILE, { readOnly: true });
db.exec('PRAGMA cache_size = -131072');
db.exec('PRAGMA mmap_size = 2147483648');
const entries = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;

const THRESHOLD = 0.8;
const QUERIES = [
  ['flavone', 'O=c1cc(-c2ccccc2)oc2ccccc12'],
  ['quercetin', 'O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12'],
];
const COLUMNS =
  's.ss_index0, s.ss_index1, s.ss_index2, s.ss_index3, s.ss_index4, s.ss_index5, s.ss_index6, s.ss_index7';
const FROM = `FROM ${TABLE} e JOIN ocl_ss_index s ON s.entry_id = e.${PK}`;

// --- A: the coefficient in JavaScript (the previous #scanSimilarityFull) ---
function unpackSSIndex(row) {
  const values = [];
  for (let i = 0; i < 8; i++) values.push(row[`ss_index${i}`] ?? 0n);
  return Array.from(new Uint32Array(new BigInt64Array(values).buffer));
}
const inJs = db.prepare(
  `SELECT e.${PK} AS entry_id, e.${ID_CODE} AS id_code, ${COLUMNS} ${FROM}`,
);
inJs.setReadBigInts(true);
function scanInJs(queryIndex) {
  const hits = [];
  for (const row of inJs.iterate()) {
    const similarity = OCL.SSSearcherWithIndex.getSimilarityTanimoto(
      queryIndex,
      unpackSSIndex(row),
    );
    if (similarity >= THRESHOLD) {
      hits.push({
        entryId: Number(row.entry_id),
        idCode: row.id_code,
        similarity,
      });
    }
  }
  return hits;
}

// --- B: the coefficient inside SQLite (src/utils/tanimotoFunction.ts) ---
let current = [];
function bitCount(value) {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
db.function(
  'bench_tanimoto',
  { deterministic: true, varargs: true },
  (...words) => {
    let shared = 0;
    let either = 0;
    for (let word = 0; word < 16; word++) {
      shared += bitCount(current[word] & words[word]);
      either += bitCount(current[word] | words[word]);
    }
    return shared / either;
  },
);
const halves = [];
for (let column = 0; column < 8; column++) {
  halves.push(
    `(s.ss_index${column} & 4294967295)`,
    `((s.ss_index${column} >> 32) & 4294967295)`,
  );
}
const inSqlite = db.prepare(
  `SELECT e.${PK} AS entry_id, e.${ID_CODE} AS id_code, bench_tanimoto(${halves.join(', ')}) AS similarity ${FROM} WHERE similarity >= ?`,
);
function scanInSqlite(queryIndex) {
  current = queryIndex;
  const hits = [];
  for (const row of inSqlite.iterate(THRESHOLD)) {
    hits.push({
      entryId: Number(row.entry_id),
      idCode: row.id_code,
      similarity: row.similarity,
    });
  }
  return hits;
}

console.log(`${entries} entries in ${FILE}, threshold ${THRESHOLD}\n`);
for (const [name, smiles] of QUERIES) {
  const queryIndex = OCL.Molecule.fromSmiles(smiles).getIndex();
  // The order of the rows is the plan's; the library sorts them afterwards.
  const ranked = (hits) =>
    hits.toSorted(
      (x, y) => y.similarity - x.similarity || x.entryId - y.entryId,
    );
  const a = ranked(scanInJs(queryIndex));
  const b = ranked(scanInSqlite(queryIndex));
  const identical =
    a.length === b.length &&
    a.every(
      (hit, i) =>
        hit.entryId === b[i].entryId && hit.similarity === b[i].similarity,
    );
  console.log(`${name} — ${a.length} hits, results identical: ${identical}`);
  if (!identical)
    throw new Error('the two scans disagree; timing them is meaningless');

  const suite = new Benchmark.Suite();
  suite
    .add('coefficient in JavaScript', () => scanInJs(queryIndex), {
      minSamples: 30,
    })
    .add('coefficient in SQLite', () => scanInSqlite(queryIndex), {
      minSamples: 30,
    })
    .on('cycle', (event) => {
      const { name: caseName, stats, hz } = event.target;
      console.log(
        `  ${caseName.padEnd(26)} ${(1000 / hz).toFixed(0).padStart(6)} ms/scan  ` +
          `${(1e9 / hz / entries).toFixed(0).padStart(5)} ns/entry  ±${stats.rme.toFixed(1)}%  (${stats.sample.length} runs)`,
      );
    })
    .on('complete', function onComplete() {
      const [js, sqlite] = this.map((bench) => bench.hz);
      console.log(
        `  → in SQLite is ${(sqlite / js).toFixed(2)}x in JavaScript\n`,
      );
    })
    .run();
}
