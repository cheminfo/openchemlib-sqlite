// End-to-end: the whole search, verified by `openchemlib` and by `openchemlib-search-wasm`.
//
// wasmParity.mjs compares the two matchers on a flat list. This runs the real pipeline instead —
// the clustered prescreen, the batching, `maxResults` cutting the scan short — and compares what
// `search()` actually returns: the entry ids, in order, with their molecular weights.
//
// Order is the point, not just membership. Candidates arrive lightest-first, so a `maxResults`
// that stops the scan early keeps a *particular* set of matches; two implementations that agree on
// the full result set can still disagree the moment one is cut short.
//
// Usage:
//   node --experimental-strip-types benchmark/wasmSearch.mjs <db.sqlite>
//
// Build the database with seedIdCodes.mjs or seedCCD.mjs. See benchmark/README.md.
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { substructureSearch } from 'openchemlib-search-wasm';

import { MoleculesDBSQLite } from '../src/index.ts';
import { prescreen } from '../src/utils/prescreen.ts';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  throw new Error('usage: wasmSearch.mjs <db.sqlite>');
}

const CONFIG = {
  entriesTable: 'ligands',
  pkColumn: 'id',
  idCodeColumn: 'id_code',
  poolSize: 1, // one thread: this compares matchers, not schedulers
  searchCacheSize: 0, // every timing must be a real scan, never a cache hit
};

const QUERIES = [
  ['benzene', 'c1ccccc1'],
  ['pyridine', 'c1ccncc1'],
  ['amide', 'CC(=O)N'],
  ['phenol', 'Oc1ccccc1'],
  ['sulfonamide', 'CS(=O)(=O)N'],
  ['indole', 'c1ccc2[nH]ccc2c1'],
  ['steroid', 'C1CC2CCC3C(CCC4CCCCC34)C2C1'],
  ['phenazine', 'c1ccc2nc3ccccc3nc2c1'],
];

// Every `maxResults` is exercised, because that is where an ordering difference would show:
// unlimited returns everything, a small cap returns only the lightest matches.
const MAX_RESULTS = [Number.MAX_SAFE_INTEGER, 500, 25];

const BATCH = 128; // the library's own verification batch size

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA mmap_size=2147418112');
db.exec('PRAGMA cache_size=-131072');
db.exec('PRAGMA temp_store=MEMORY');
const molDB = new MoleculesDBSQLite(db, OCL, CONFIG);

const indexed = db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get().n;
console.log(`${indexed} indexed molecules\n`);

/**
 * The same pipeline `runSubstructureSearch` runs, with the wasm matcher in place of the
 * `SSSearcher` verifier: the same prescreen, in the same order, batched the same way, stopping at
 * the same `maxResults`.
 */
function wasmSearch(mol, maxResults) {
  const state = { screened: 0, partial: false };
  const results = [];
  const fragment = mol.getAllAtoms() === 0 ? '' : mol.getIDCode();
  const emptyFragment = fragment === '';
  const batch = [];
  let stop = false;

  const flush = () => {
    if (batch.length === 0) return;
    const matches = emptyFragment ? batch : substructureSearch(fragment, batch).matches;
    for (const match of matches) {
      results.push(match);
      if (results.length >= maxResults) {
        state.partial = true;
        stop = true;
        break;
      }
    }
    batch.length = 0;
  };

  for (const candidate of prescreen(
    {
      db,
      entriesTable: CONFIG.entriesTable,
      pkColumn: CONFIG.pkColumn,
      idCodeColumn: CONFIG.idCodeColumn,
      mol,
      timeoutMs: 600_000,
      maxCandidates: Number.MAX_SAFE_INTEGER,
    },
    state,
  )) {
    batch.push({ entryId: candidate.entryId, idCode: candidate.idCode, mw: candidate.mw });
    if (batch.length >= Math.max(1, Math.min(BATCH, maxResults - results.length))) {
      flush();
      if (stop) break;
    }
  }
  if (!stop) flush();
  return { results, total: results.length, screened: state.screened };
}

/** Two result lists agree only if they hold the same entries, with the same weights, in order. */
function compare(a, b) {
  if (a.length !== b.length) return `lengths ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i].entryId !== b[i].entryId) {
      return `position ${i}: entryId ${a[i].entryId} vs ${b[i].entryId}`;
    }
    if (a[i].idCode !== b[i].idCode) return `position ${i}: idCode differs`;
    if (a[i].mw !== b[i].mw) return `position ${i}: mw ${a[i].mw} vs ${b[i].mw}`;
  }
  return null;
}

let failures = 0;
console.log('  query          maxResults   matches   screened      OCL       wasm   speedup   agree');
for (const [name, smiles] of QUERIES) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  const queryIdCode = mol.getIDCode();

  for (const maxResults of MAX_RESULTS) {
    const options = {
      mode: 'substructure',
      format: 'idCode',
      maxResults,
      timeoutMs: 600_000,
      limit: Number.MAX_SAFE_INTEGER,
    };

    const oclStart = performance.now();
    // eslint-disable-next-line no-await-in-loop -- intentional: one timed search at a time
    const oclRun = await molDB.search(queryIdCode, options);
    const oclMs = performance.now() - oclStart;

    const wasmStart = performance.now();
    const wasmRun = wasmSearch(mol, maxResults);
    const wasmMs = performance.now() - wasmStart;

    const difference = compare(oclRun.results, wasmRun.results);
    if (difference) failures++;
    const cap = maxResults === Number.MAX_SAFE_INTEGER ? 'none' : String(maxResults);
    console.log(
      `  ${name.padEnd(13)} ${cap.padStart(10)}   ${String(oclRun.total).padStart(7)}   ` +
        `${String(oclRun.screened).padStart(8)}   ${oclMs.toFixed(0).padStart(6)}ms   ` +
        `${wasmMs.toFixed(0).padStart(6)}ms   ${(oclMs / wasmMs).toFixed(2).padStart(6)}x   ` +
        `${difference ? `NO (${difference})` : 'yes'}`,
    );
  }
}

await molDB.close();
db.close();

console.log(
  `\n${failures === 0 ? 'IDENTICAL — every search returned the same entries, in the same order.' : `${failures} DISAGREEMENTS`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
