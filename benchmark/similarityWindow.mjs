// A/B: a similarity scan computing the Tanimoto coefficient for every row, against the same scan
// skipping the rows whose bit count puts the threshold out of reach.
//
//   node benchmark/similarityWindow.mjs <index.sqlite>
//
// Tanimoto(q, r) ≥ t needs t·|q| ≤ |r| ≤ |q|/t: the bits two fingerprints share are at most the
// smaller count, and the bits either sets at least the larger. With each row's bit count stored,
// a row outside that window is rejected by one comparison instead of a call into JavaScript with
// sixteen words. The script copies the index once into `<index>.bits.sqlite` and stores each
// row's count there, then times the scans on that copy, in one process, with the library's own
// coefficient function and deadline guard: A as the scan ran before; B with the window right after
// the guard, a row whose count is not known still computed, as the scan runs now; C the same
// window without that test, which is what the test costs. All must return the same entries with
// the same coefficients. The bit count and the window are written out here, as the library
// computes them, so the script runs on a checkout from before them.
import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import {
  installScanDeadline,
  scanDeadlineGuard,
} from '../src/utils/scanDeadline.ts';
import {
  installTanimoto,
  tanimotoSql,
  withTanimotoQuery,
} from '../src/utils/tanimotoFunction.ts';

const SOURCE = process.argv[2];
if (!SOURCE) throw new Error('usage: similarityWindow.mjs <index.sqlite>');
const FILE = `${SOURCE}.bits.sqlite`;
const QUERIES = {
  quercetin: 'O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12',
  flavone: 'O=c1cc(-c2ccccc2)oc2ccccc12',
};
const THRESHOLDS = [0.8, 0.6];

if (!existsSync(FILE)) {
  copyFileSync(SOURCE, FILE);
  const db = new DatabaseSync(FILE);
  db.function('bits', { deterministic: true, varargs: true }, (...values) => {
    let count = 0;
    for (const value of values) count += bitCount(Number(value));
    return count;
  });
  db.exec('ALTER TABLE ocl_ss_index ADD COLUMN ss_bits INTEGER');
  db.exec(`UPDATE ocl_ss_index SET ss_bits = bits(${words('ocl_ss_index')})`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

const db = new DatabaseSync(FILE, { readOnly: true });
db.exec('PRAGMA cache_size = -131072');
db.exec('PRAGMA mmap_size = 2147483648');
installTanimoto(db);
installScanDeadline(db);
const rows = db.prepare('SELECT count(*) AS n FROM ocl_ss_index').get().n;
const select = `SELECT s.entry_id, ${tanimotoSql('s')} AS similarity FROM ocl_ss_index s`;
const guard = scanDeadlineGuard('s.entry_id');
const scans = {
  'A every row': db.prepare(`${select} WHERE ${guard} AND similarity >= ?`),
  'B bit-count window': db.prepare(
    `${select} WHERE ${guard} AND (s.ss_bits IS NULL OR s.ss_bits BETWEEN ? AND ?) AND similarity >= ?`,
  ),
  'C window, no NULL test': db.prepare(
    `${select} WHERE ${guard} AND s.ss_bits BETWEEN ? AND ? AND similarity >= ?`,
  ),
};

for (const [name, smiles] of Object.entries(QUERIES)) {
  const query = OCL.Molecule.fromSmiles(smiles).getIndex();
  for (const threshold of THRESHOLDS) {
    let bits = 0;
    for (const word of query) bits += bitCount(word >>> 0);
    const low = Math.max(0, Math.ceil(threshold * bits - 1e-9));
    const high = Math.floor(bits / threshold + 1e-9);
    const within = db
      .prepare(
        'SELECT count(*) AS n FROM ocl_ss_index WHERE ss_bits BETWEEN ? AND ?',
      )
      .get(low, high).n;
    const answers = new Map();
    const suite = new Benchmark.Suite();
    for (const [label, statement] of Object.entries(scans)) {
      suite.add(label, {
        minSamples: 30,
        fn() {
          const far = Date.now() + 3_600_000;
          const hits = withTanimotoQuery(query, (key) =>
            label.startsWith('A')
              ? statement.all(key, far, threshold)
              : statement.all(key, far, low, high, threshold),
          );
          let sum = 0;
          for (const hit of hits) sum += hit.entry_id * hit.similarity;
          answers.set(label, `${hits.length} hits, checksum ${sum.toFixed(6)}`);
        },
      });
    }
    suite
      .on('cycle', (event) => {
        const { name: label, stats } = event.target;
        console.log(
          `${name.padEnd(10)} ≥${threshold} ${label.padEnd(22)} ${(stats.mean * 1000).toFixed(0).padStart(6)} ms ` +
            `${((stats.mean * 1e9) / rows).toFixed(0).padStart(5)} ns/row ±${stats.rme.toFixed(1)}%  ` +
            `${answers.get(label)}; ${((100 * within) / rows).toFixed(1)}% of rows in the window`,
        );
      })
      .run();
  }
}

/**
 * The sixteen 32-bit words of a row's fingerprint, as SQL.
 * @param {string} alias - The table.
 * @returns {string} The words, comma-separated.
 */
function words(alias) {
  const out = [];
  for (let column = 0; column < 8; column++) {
    const value = `${alias}.ss_index${column}`;
    out.push(`(${value} & 4294967295)`, `((${value} >> 32) & 4294967295)`);
  }
  return out.join(', ');
}

/**
 * How many bits a 32-bit word sets.
 * @param {number} value - The word.
 * @returns {number} Its population count.
 */
function bitCount(value) {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
