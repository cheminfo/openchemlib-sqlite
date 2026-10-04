// A/B: the sample a column scan measures its prefilter on, read from a cold index, without and
// with a time budget.
//
//   node benchmark/coldSample.mjs <index.sqlite>
//
// Linux only: every operation first drops the file from the page cache (posix_fadvise DONTNEED,
// through python3) and opens a fresh connection set up as molecules.cheminfo.org's readers are —
// 128 MB cache, 2 GB mmap — so each one reads the index as the first search of a process does. A reads the whole sample — 32 entry seeks, then 32 runs of 64 rows — as the
// scan did; B stops starting seeks and runs once 20 ms have passed, as it does now, and reads them
// in an order whose every prefix is spread over the index. Each line prints the runs read.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';

const FILE = process.argv[2];
if (!FILE) throw new Error('usage: coldSample.mjs <index.sqlite>');
const EVICT = `import os, sys
for name in (sys.argv[1], sys.argv[1] + "-wal"):
    if os.path.exists(name):
        fd = os.open(name, os.O_RDONLY)
        os.fsync(fd)
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        os.close(fd)`;
const RUNS = 32;
const RUN_LENGTH = 64;
const BUDGET_MS = 20;
const BOUNDS = `SELECT (SELECT MIN(entry_id) FROM ocl_ss_index) AS low,
                       (SELECT MAX(entry_id) FROM ocl_ss_index) AS high`;
const KEY_OF = `SELECT mw, entry_id FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry
                 WHERE entry_id >= ? ORDER BY entry_id LIMIT 1`;
const RUN = `SELECT count(*) AS n, sum((s.ss_index3 & 15) = 15) AS w3
               FROM (SELECT s.ss_index3 FROM ocl_ss_index s
                      WHERE (s.mw, s.entry_id) >= (?, ?)
                      ORDER BY s.mw, s.entry_id LIMIT ?) s`;

const runsRead = new Map();
const suite = new Benchmark.Suite();
suite.add('A whole sample', {
  minSamples: 30,
  fn() {
    const db = coldConnection();
    runsRead.set('A whole sample', sampleWhole(db));
    db.close();
  },
});
suite.add('B 20 ms budget', {
  minSamples: 30,
  fn() {
    const db = coldConnection();
    runsRead.set('B 20 ms budget', sampleWithin(db, Date.now() + BUDGET_MS));
    db.close();
  },
});
suite
  .on('cycle', (event) => {
    const { name, stats } = event.target;
    console.log(
      `${name.padEnd(16)} ${(stats.mean * 1000).toFixed(1).padStart(8)} ms ±${stats.rme.toFixed(1)}%  ` +
        `${runsRead.get(name)} runs read (eviction and open included)`,
    );
  })
  .run();

/**
 * The index with nothing of it in the page cache, on a fresh connection.
 * @returns {DatabaseSync} The connection.
 */
function coldConnection() {
  spawnSync('python3', ['-c', EVICT, FILE]);
  const db = new DatabaseSync(FILE, { readOnly: true });
  db.exec('PRAGMA cache_size = -131072');
  db.exec('PRAGMA mmap_size = 2147483648');
  return db;
}

/**
 * The sample as the scan read it before: every seek, then every run.
 * @param {DatabaseSync} db - The connection.
 * @returns {number} The runs read.
 */
function sampleWhole(db) {
  const { low, high } = db.prepare(BOUNDS).get();
  const keyOf = db.prepare(KEY_OF);
  const run = db.prepare(RUN);
  const keys = [];
  for (let index = 0; index < RUNS; index++) {
    const id = low + Math.floor(((index + 0.5) * (high - low + 1)) / RUNS);
    const key = keyOf.get(id);
    if (key !== undefined) keys.push(key);
  }
  let read = 0;
  for (const key of keys) {
    run.get(key.mw, key.entry_id, RUN_LENGTH);
    read++;
  }
  return read;
}

/**
 * The sample as the scan reads it now: in spread order, nothing started past
 * the budget.
 * @param {DatabaseSync} db - The connection.
 * @param {number} budgetEnd - When to stop, in ms since the epoch.
 * @returns {number} The runs read.
 */
function sampleWithin(db, budgetEnd) {
  const { low, high } = db.prepare(BOUNDS).get();
  const keyOf = db.prepare(KEY_OF);
  const run = db.prepare(RUN);
  const keys = [];
  for (let index = 0; index < RUNS; index++) {
    if (Date.now() > budgetEnd) return 0;
    const spread = reverseBits(index, Math.log2(RUNS));
    const id = low + Math.floor(((spread + 0.5) * (high - low + 1)) / RUNS);
    const key = keyOf.get(id);
    if (key !== undefined) keys.push(key);
  }
  let read = 0;
  for (const key of keys) {
    if (Date.now() > budgetEnd) break;
    run.get(key.mw, key.entry_id, RUN_LENGTH);
    read++;
  }
  return read;
}

/**
 * A number with its low bits in reverse order.
 * @param {number} value - The number.
 * @param {number} bits - How many low bits.
 * @returns {number} The reversed number.
 */
function reverseBits(value, bits) {
  let reversed = 0;
  for (let bit = 0; bit < bits; bit++) {
    reversed |= ((value >> bit) & 1) << (bits - 1 - bit);
  }
  return reversed;
}
