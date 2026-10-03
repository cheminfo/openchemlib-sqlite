// What each way of applying a filter costs a substructure page.
//
//   node --experimental-strip-types benchmark/filteredScan.mjs <bench.sqlite> [copies]
//
// A filter on something the index does not hold reaches the scan as a candidates subquery. As a
// `membership` list it is listed whole before the first candidate is read — the cost of the
// subquery, not of the page. As a `probe` it is tested per candidate the prefilter lets through,
// and as `drive` the subquery is the outer loop. The weight is the one bound the index can seek,
// through `mwRange`.
//
// The difference is one of scale — a membership list grows with the database, a probed page does
// not — so the bench database (seedIdCodes.mjs or seedCCD.mjs) is first scaled `copies` times into
// a file beside it: every entry and fingerprint repeated under new ids, never recomputed. Each
// entry gets two synthetic attributes to filter on: `band` (id % 100, no index) and `tag`
// (id % 10000, indexed).
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';

const SOURCE = process.argv[2];
const COPIES = Number(process.argv[3] ?? 100);
if (!SOURCE) {
  throw new Error('usage: filteredScan.mjs <bench.sqlite> [copies]');
}
const SCALED = `${SOURCE}.x${COPIES}.sqlite`;
if (!existsSync(SCALED)) scale(SOURCE, SCALED, COPIES);

const db = new DatabaseSync(SCALED);
db.exec('PRAGMA mmap_size=2147418112');
db.exec('PRAGMA cache_size=-131072');
db.exec('PRAGMA temp_store=MEMORY');
const molDB = new MoleculesDBSQLite(db, OCL, {
  entriesTable: 'ligands',
  pkColumn: 'id',
  idCodeColumn: 'id_code',
  searchCacheSize: 0, // every timing must be a real scan, never a cache hit
});
const { n: entries } = db.prepare('SELECT COUNT(*) AS n FROM ligands').get();

// Benzene is in most entries, so a page fills almost at once: whatever a run costs beyond a few
// milliseconds is how the filter was applied.
const QUERY = 'c1ccccc1';
const PAGE = {
  mode: 'substructure',
  limit: 24,
  maxResults: 24,
  timeoutMs: 120_000,
};
const subquery = (where) => `SELECT id AS entry_id FROM ligands WHERE ${where}`;

const CASES = [
  {
    name: 'broad: mw >= 260 AND band < 80, as a browse page sends it',
    runs: {
      membership: {
        candidates: {
          sql: subquery('mw >= :mw AND band < :band'),
          params: { mw: 260, band: 80 },
        },
      },
      'mwRange + probe': {
        mwRange: { min: 260 },
        candidates: {
          sql: subquery('band < :band'),
          params: { band: 80 },
          strategy: 'probe',
        },
      },
    },
  },
  {
    name: 'selective, no index: band = 7 (1%)',
    runs: {
      membership: {
        candidates: { sql: subquery('band = :band'), params: { band: 7 } },
      },
      probe: {
        candidates: {
          sql: subquery('band = :band'),
          params: { band: 7 },
          strategy: 'probe',
        },
      },
    },
  },
  {
    name: 'selective, indexed: tag = 7 (0.01%)',
    runs: Object.fromEntries(
      ['membership', 'probe', 'drive'].map((strategy) => [
        strategy,
        {
          candidates: {
            sql: subquery('tag = :tag'),
            params: { tag: 7 },
            strategy,
          },
        },
      ]),
    ),
  },
];

console.log(`${entries} entries (${COPIES} copies of ${SOURCE})\n`);
for (const { name, runs } of CASES) {
  console.log(name);
  let reference;
  for (const [label, options] of Object.entries(runs)) {
    // eslint-disable-next-line no-await-in-loop -- intentional: measure one run at a time
    const { ms, last } = await best(() =>
      molDB.search(QUERY, { ...PAGE, ...options }),
    );
    const ids = last.results.map((result) => result.entryId).join(',');
    reference ??= ids;
    console.log(
      `  ${label.padEnd(16)} ${ms.toFixed(1).padStart(9)} ms  ${last.results.length} results, ${last.screened} screened${ids === reference ? '' : '  DIFFERENT ANSWER'}`,
    );
    if (ids !== reference) process.exitCode = 1;
  }
}
await molDB.close();

/**
 * The fastest of several runs, and what the last one answered.
 * @param run - The run to time.
 * @param times - How many runs.
 * @returns The best time in ms and the last answer.
 */
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

/**
 * Write a copy of a bench database with every entry repeated `copies` times.
 * @param source - The bench database.
 * @param target - The file to write.
 * @param copies - How many times each entry appears.
 */
function scale(source, target, copies) {
  const started = Date.now();
  const out = new DatabaseSync(target);
  out.exec('PRAGMA journal_mode = OFF');
  out.exec('PRAGMA synchronous = OFF');
  out.exec(`ATTACH DATABASE '${source}' AS base`);
  out.exec(`CREATE TABLE ligands (
    id INTEGER PRIMARY KEY, id_code TEXT NOT NULL,
    mw REAL NOT NULL, band INTEGER NOT NULL, tag INTEGER NOT NULL
  )`);
  new MoleculesDBSQLite(out, OCL, {
    entriesTable: 'ligands',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
  }).migrate();
  // The fold's tail would copy every row a second time; nothing here reads it.
  out.exec('DROP TRIGGER IF EXISTS ocl_ss_tail_insert');
  const copy = `WITH RECURSIVE copy(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM copy WHERE k < ${copies - 1})`;
  // Copy k of entry i is id i * copies + k, so copies interleave as real entries of every weight do.
  const id = `s.entry_id * ${copies} + c.k`;
  const words = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((word) => `ss_index${word}`)
    .join(', ');
  out.exec('BEGIN');
  out.exec(`${copy} INSERT INTO ligands (id, id_code, mw, band, tag)
    SELECT ${id}, l.id_code, s.mw, (${id}) % 100, (${id}) % 10000
    FROM base.ocl_ss_index s JOIN base.ligands l ON l.id = s.entry_id JOIN copy c ORDER BY 1`);
  out.exec(`${copy} INSERT INTO ocl_ss_index (mw, entry_id, ${words})
    SELECT s.mw, ${id}, ${words.replaceAll('ss_', 's.ss_')}
    FROM base.ocl_ss_index s JOIN copy c ORDER BY 1, 2`);
  out.exec('COMMIT');
  out.exec('CREATE INDEX ligands_tag ON ligands (tag)');
  out.exec('DETACH DATABASE base');
  out.close();
  console.log(`scaled to ${target} in ${Date.now() - started} ms`);
}
