// A/B: the prefilter and the deadline guard of a column scan, per row.
//
// A full scan of `ocl_ss_index` counting the rows the fingerprint prefilter lets through, three
// ways, in one process on the same file:
//
//   A  every fingerprint word tested, in column order, the guard first — what a scan ran before
//   B  only the query's non-zero words, the one a sample spread over the index shows most
//      selective first, and the guard right after it, reading the clock as often per row as before
//   C  B without any guard, which is what the guard costs B
//
// Then each guarded form is given a deadline 200 ms away, which only the guard can enforce inside
// a count, and the overshoot is printed: B must stop as promptly as A.
//
//   node benchmark/prefilterGuard.mjs <index.sqlite>
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { packSSIndex } from '../src/utils/packSSIndex.ts';

const FILE = process.argv[2];
if (!FILE) throw new Error('usage: prefilterGuard.mjs <index.sqlite>');
const QUERIES = {
  benzene: 'c1ccccc1',
  quercetin: 'O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12',
  dibenzoselenophene: 'c1ccc2c(c1)[se]c1ccccc12',
  steroid: 'C1CCC2C(C1)CCC1C2CCC2CCCC12',
};

const db = new DatabaseSync(FILE, { readOnly: true });
db.exec('PRAGMA cache_size = -131072');
db.exec('PRAGMA mmap_size = 2147483648');
db.function('ocl_ss_deadline', { deterministic: false, varargs: true }, (d) => {
  if (Date.now() > Number(d)) throw new Error('the scan ran past its deadline');
  return 1;
});
const rows = db.prepare('SELECT count(*) AS n FROM ocl_ss_index').get().n;

for (const [name, smiles] of Object.entries(QUERIES)) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  const words = packSSIndex(mol.getIndex());
  const variants = {
    'A column order, guard first': before(words),
    'B measured order, guard second': after(words, true),
    'C measured order, no guard': after(words, false),
  };
  const counts = new Map();
  const suite = new Benchmark.Suite();
  for (const [label, { sql, params }] of Object.entries(variants)) {
    const statement = db.prepare(`SELECT count(*) AS n FROM ocl_ss_index s WHERE ${sql}`);
    suite.add(label, {
      minSamples: 30,
      fn() {
        counts.set(label, statement.get(...params(Date.now() + 3_600_000)).n);
      },
    });
  }
  suite
    .on('cycle', (event) => {
      const { name: label, stats } = event.target;
      console.log(
        `${name.padEnd(19)} ${label.padEnd(32)} ${(stats.mean * 1000).toFixed(0).padStart(6)} ms ` +
          `${((stats.mean * 1e9) / rows).toFixed(1).padStart(6)} ns/row ±${stats.rme.toFixed(1)}%  ${counts.get(label)} rows`,
      );
    })
    .run();
}

// The overshoot: counting runs the whole scan inside one step, so only the guard sees the clock.
for (const [name, smiles] of Object.entries(QUERIES)) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  const words = packSSIndex(mol.getIndex());
  for (const [label, { sql, params }] of Object.entries({
    A: before(words),
    B: after(words, true),
  })) {
    const statement = db.prepare(`SELECT count(*) AS n FROM ocl_ss_index s WHERE ${sql}`);
    const overshoots = [];
    for (let run = 0; run < 5; run++) {
      const deadline = Date.now() + 200;
      try {
        statement.get(...params(deadline));
      } catch {
        // the guard stopped it, which is the point
      }
      overshoots.push(Date.now() - deadline);
    }
    console.log(`${name.padEnd(19)} overshoot past a 200 ms deadline, ${label}: ${overshoots.join(', ')} ms`);
  }
}

/**
 * The scan as it was: every word, in column order, the guard first.
 * @param {bigint[]} words - The query's eight 64-bit words.
 * @returns {{ sql: string, params: (deadline: number) => unknown[] }} The conditions.
 */
function before(words) {
  const terms = words.map((_, index) => `(s.ss_index${index} & ?) = ?`);
  return {
    sql: `((s.entry_id & 1023) <> 0 OR ocl_ss_deadline(?)) AND ${terms.join(' AND ')}`,
    params: (deadline) => [deadline, ...words.flatMap((word) => [word, word])],
  };
}

/**
 * How many rows of 32 runs spread over the index, each starting at an entry chosen by id, some
 * words let through.
 * @param {bigint[]} words - The query's eight 64-bit words.
 * @param {number[]} present - The words to count.
 * @param {number} length - Rows per run.
 * @returns {Record<string, number>} The passes by word (`w<n>`), and the rows read (`n`).
 */
function sample(words, present, length) {
  const run = db.prepare(
    `SELECT count(*) AS n, ${present.map((index) => `sum((ss_index${index} & ?) = ?) AS w${index}`).join(', ')}
       FROM (SELECT * FROM ocl_ss_index WHERE (mw, entry_id) >= (?, ?)
              ORDER BY mw, entry_id LIMIT ${length})`,
  );
  const keyOf = db.prepare(
    'SELECT mw, entry_id FROM ocl_ss_index WHERE entry_id >= ? ORDER BY entry_id LIMIT 1',
  );
  const { low, high } = db
    .prepare('SELECT MIN(entry_id) AS low, MAX(entry_id) AS high FROM ocl_ss_index')
    .get();
  const passes = { n: 0 };
  for (let k = 0; k < 32; k++) {
    const key = keyOf.get(low + Math.floor(((k + 0.5) * (high - low + 1)) / 32));
    const row = run.get(
      ...present.flatMap((index) => [words[index], words[index]]),
      key.mw,
      key.entry_id,
    );
    passes.n += row.n;
    for (const index of present) {
      passes[`w${index}`] = (passes[`w${index}`] ?? 0) + row[`w${index}`];
    }
  }
  return passes;
}

/**
 * The scan reordered by what a sample of its rows shows, with the guard after the first word.
 * @param {bigint[]} words - The query's eight 64-bit words.
 * @param {boolean} guarded - Whether to keep the guard.
 * @returns {{ sql: string, params: (deadline: number) => unknown[] }} The conditions.
 */
function after(words, guarded) {
  const present = [];
  for (let index = 0; index < words.length; index++) {
    if (words[index] !== 0n) present.push(index);
  }
  // 32 runs of 64 rows, each starting at an entry chosen by id: consecutive
  // rows of a weight-ordered index are isomers, alike in the bits measured.
  const passes = sample(words, present, 64);
  const order = present.toSorted((a, b) => passes[`w${a}`] - passes[`w${b}`]);
  let firstPasses = passes[`w${order[0]}`] ?? 0;
  let rows = passes.n;
  if (firstPasses < 4) {
    // Too rare to judge on 2048 rows: 65 536, for that word alone.
    const rare = sample(words, [order[0]], 2048);
    firstPasses = rare[`w${order[0]}`] ?? 0;
    rows = rare.n;
  }
  // One call in about 1024 rows read, as before: the rows reaching the guard are a share of them.
  let mask = 1;
  while (mask * 2 <= (1024 * firstPasses) / rows) mask *= 2;
  const second = guarded && firstPasses >= 4;
  const term = (index) => `(s.ss_index${index} & ?) = ?`;
  const guard = (bits) =>
    bits === 0 ? 'ocl_ss_deadline(?)' : `((s.entry_id & ${bits}) <> 0 OR ocl_ss_deadline(?))`;
  const parts = order.map(term);
  if (guarded) parts.splice(second ? 1 : 0, 0, guard(second ? mask - 1 : 1023));
  return {
    sql: parts.join(' AND '),
    params: (deadline) => {
      const values = order.flatMap((index) => [words[index], words[index]]);
      if (guarded) values.splice(second ? 2 : 0, 0, deadline);
      return values;
    },
  };
}
