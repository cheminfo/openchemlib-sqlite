// End-to-end: does `search()` still return what `openchemlib` alone would return?
//
// The library verifies with `openchemlib-search-wasm`. This runs the real pipeline — the clustered
// prescreen, the batching, `maxResults` cutting the scan short — against a reference that uses
// nothing but `openchemlib`, and compares what comes back: the entry ids, in order, with their
// molecular weights.
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

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA mmap_size=2147418112');
db.exec('PRAGMA cache_size=-131072');
db.exec('PRAGMA temp_store=MEMORY');
const molDB = new MoleculesDBSQLite(db, OCL, CONFIG);

const indexed = db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get().n;
console.log(`${indexed} indexed molecules\n`);

/**
 * The reference: the same pipeline `runSubstructureSearch` runs — the same prescreen, in the same
 * order, stopping at the same `maxResults` — but matching with `openchemlib`'s own `SSSearcher`,
 * one candidate at a time, against the query `Molecule` itself.
 *
 * Nothing here touches `openchemlib-search-wasm`, so agreement is real evidence rather than two
 * spellings of one implementation.
 */
function oclSearch(mol, maxResults) {
  const state = { screened: 0, partial: false };
  const results = [];
  const emptyFragment = mol.getAllAtoms() === 0;
  const searcher = new OCL.SSSearcher();
  if (!emptyFragment) searcher.setFragment(mol);

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
    if (!emptyFragment) {
      // `false` skips 2D-coordinate invention: a graph match never looks at coordinates.
      searcher.setMolecule(OCL.Molecule.fromIDCode(candidate.idCode, false));
      if (!searcher.isFragmentInMolecule()) continue;
    }
    results.push({
      entryId: candidate.entryId,
      idCode: candidate.idCode,
      mw: candidate.mw,
    });
    if (results.length >= maxResults) {
      state.partial = true;
      break;
    }
  }
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
console.log('  query          maxResults   matches   screened      OCL   library   speedup   agree');
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

    const libStart = performance.now();
    // eslint-disable-next-line no-await-in-loop -- intentional: one timed search at a time
    const libRun = await molDB.search(queryIdCode, options);
    const libMs = performance.now() - libStart;

    const oclStart = performance.now();
    const oclRun = oclSearch(mol, maxResults);
    const oclMs = performance.now() - oclStart;

    const difference = compare(libRun.results, oclRun.results);
    if (difference) failures++;
    const cap = maxResults === Number.MAX_SAFE_INTEGER ? 'none' : String(maxResults);
    console.log(
      `  ${name.padEnd(13)} ${cap.padStart(10)}   ${String(libRun.total).padStart(7)}   ` +
        `${String(libRun.screened).padStart(8)}   ${oclMs.toFixed(0).padStart(6)}ms   ` +
        `${libMs.toFixed(0).padStart(6)}ms   ${(oclMs / libMs).toFixed(2).padStart(6)}x   ` +
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
