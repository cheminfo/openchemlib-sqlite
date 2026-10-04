// A/B: a bound on a property of the molecule, probed in the caller's tables for every candidate,
// against the same bound on a column the index carries in the row the scan already reads.
//
//   node benchmark/carriedColumns.mjs <index.sqlite> <entries.sqlite>
//
// The layout is molecules.cheminfo.org's: the entries file holds `molecules (id, idCode, formulaId,
// rotatableBondCount, logP, …)` and `formulas (id, …)`, attached as `mol`; the index carries
// `col_rotatableBondCount` and `col_logP`. Two measurements:
//
//   scan   every heavy benzene candidate (mw ≥ 610, prefilter passed) tested against the bound,
//          counted in SQL, three ways: the probe molecules.cheminfo.org sends (molecules joined to
//          formulas), the same probe without the formulas join, and the carried column
//   page   a first page of 24 through the library: the probe as a `candidates` subquery, against
//          `columnRanges`, with a 10 s budget and 6 verifier threads
//
// Each line prints what it counted or found, so the variants can be checked for the same answer.
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';
import { buildSSPrefilter } from '../src/utils/buildSSPrefilter.ts';

const [INDEX, ENTRIES] = process.argv.slice(2);
if (!INDEX || !ENTRIES) {
  throw new Error('usage: carriedColumns.mjs <index.sqlite> <entries.sqlite>');
}
const BENZENE = OCL.Molecule.fromSmiles('c1ccccc1');
BENZENE.setFragment(true);
const MW_MIN = 610;
const CASES = {
  'rot ≤ 4': { rotatableBondCount: { max: 4 } },
  'rot ≤ 2': { rotatableBondCount: { max: 2 } },
  'rot ≤ 2, logP ≤ 3': { rotatableBondCount: { max: 2 }, logP: { max: 3 } },
  'rot ≤ 1, logP ≤ -2': { rotatableBondCount: { max: 1 }, logP: { max: -2 } },
};

const db = new DatabaseSync(INDEX, { readOnly: true });
db.exec('PRAGMA cache_size = -131072');
db.exec('PRAGMA temp_store = MEMORY');
db.exec('PRAGMA mmap_size = 2147483648');
db.exec(`ATTACH DATABASE '${ENTRIES}' AS mol`);
const molDB = new MoleculesDBSQLite(db, OCL, {
  entriesTable: 'mol.molecules',
  pkColumn: 'id',
  idCodeColumn: 'idCode',
  poolSize: 6,
  searchCacheSize: 0,
  columns: { rotatableBondCount: 'integer', logP: 'real' },
});

const prefilter = buildSSPrefilter(BENZENE.getIndex());
const heavy = `FROM ocl_ss_index s WHERE ${prefilter.sql} AND s.mw >= ${MW_MIN}`;

for (const [label, ranges] of Object.entries(CASES)) {
  const where = [];
  const columns = [];
  for (const [column, range] of Object.entries(ranges)) {
    if (range.min !== undefined) {
      where.push(`m.${column} >= ${range.min}`);
      columns.push(`s.col_${column} >= ${range.min}`);
    }
    if (range.max !== undefined) {
      where.push(`m.${column} <= ${range.max}`);
      columns.push(`s.col_${column} <= ${range.max}`);
    }
  }
  const scans = {
    'probe, molecules ⋈ formulas': `SELECT count(*) AS n ${heavy} AND EXISTS (SELECT 1 FROM (SELECT m.id AS entry_id FROM mol.molecules m JOIN mol.formulas f ON f.id = m.formulaId WHERE ${where.join(' AND ')}) c WHERE c.entry_id = s.entry_id)`,
    'probe, molecules alone': `SELECT count(*) AS n ${heavy} AND EXISTS (SELECT 1 FROM mol.molecules m WHERE m.id = s.entry_id AND ${where.join(' AND ')})`,
    'carried column': `SELECT count(*) AS n ${heavy} AND ${columns.join(' AND ')}`,
  };
  const counts = new Map();
  const scanSuite = new Benchmark.Suite();
  for (const [name, sql] of Object.entries(scans)) {
    const statement = db.prepare(sql);
    scanSuite.add(name, {
      minSamples: 30,
      fn() {
        counts.set(name, statement.get(...prefilter.params).n);
      },
    });
  }
  const candidates = db.prepare(`SELECT count(*) AS n ${heavy}`).get(...prefilter.params).n;
  scanSuite
    .on('cycle', (event) => {
      const { name, stats } = event.target;
      console.log(
        `scan ${label.padEnd(20)} ${name.padEnd(28)} ${(stats.mean * 1000).toFixed(1).padStart(8)} ms ` +
          `${((stats.mean * 1e6) / candidates).toFixed(2).padStart(6)} µs/candidate ±${stats.rme.toFixed(1)}%  ` +
          `${counts.get(name)} of ${candidates}`,
      );
    })
    .run();

  const pages = {
    probe: {
      mwRange: { min: MW_MIN },
      candidates: {
        sql: `SELECT m.id AS entry_id FROM mol.molecules m JOIN mol.formulas f ON f.id = m.formulaId WHERE ${where.join(' AND ')}`,
        strategy: 'probe',
      },
    },
    'columnRanges': { mwRange: { min: MW_MIN }, columnRanges: ranges },
  };
  const found = new Map();
  const pageSuite = new Benchmark.Suite();
  for (const [name, options] of Object.entries(pages)) {
    pageSuite.add(name, {
      defer: true,
      minSamples: 30,
      fn(deferred) {
        molDB
          .search(BENZENE, {
            mode: 'substructure',
            maxResults: 24,
            limit: 24,
            timeoutMs: 10_000,
            ...options,
          })
          .then((response) => {
            found.set(
              name,
              `${response.total} ${response.results.slice(0, 4).map((hit) => hit.entryId).join(',')}${response.timedOut ? ' timed out' : ''}`,
            );
            deferred.resolve();
          });
      },
    });
  }
  // eslint-disable-next-line no-await-in-loop -- one suite at a time
  await new Promise((resolve) => {
    pageSuite
      .on('cycle', (event) => {
        const { name, stats } = event.target;
        console.log(
          `page ${label.padEnd(20)} ${name.padEnd(28)} ${(stats.mean * 1000).toFixed(1).padStart(8)} ms ±${stats.rme.toFixed(1)}%  ${found.get(name)}`,
        );
      })
      .on('complete', resolve)
      .run({ async: true });
  });
}
await molDB.close();
