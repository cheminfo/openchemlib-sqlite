// A/B: does `openchemlib-search-wasm` verify a batch of candidates faster than `openchemlib`?
//
// Both implementations are copied into this file and run in one process on the same candidates,
// so the two numbers are comparable. The verification is ~97% of a substructure search, so this
// is the number that decides whether the wasm build is worth depending on.
//
// The fingerprint is measured too: it is what indexing a library costs, one molecule at a time.
//
// Usage:
//   node --experimental-strip-types benchmark/wasmVerify.mjs <idcodes.txt> [batchSize]
import { readFileSync } from 'node:fs';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';
import { getIndex, substructureSearch } from 'openchemlib-search-wasm';

const FILE = process.argv[2];
const BATCH = process.argv[3] ? Number(process.argv[3]) : 10_000;
if (!FILE) {
  throw new Error('usage: wasmVerify.mjs <idcodes.txt> [batchSize]');
}

const all = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
const candidates = all.slice(0, Math.min(BATCH, all.length));

// Two fragments with very different hit rates. A query almost everything matches and a query
// almost nothing matches exercise different amounts of the matcher, and a build can win one and
// lose the other.
const QUERIES = [
  ['benzene (common)', 'c1ccccc1'],
  ['phenazine (rare)', 'c1ccc2nc3ccccc3nc2c1'],
];

console.log(`${candidates.length} candidates per call, from ${FILE}\n`);

for (const [name, smiles] of QUERIES) {
  const query = OCL.Molecule.fromSmiles(smiles);
  query.setFragment(true);
  const queryIdCode = query.getIDCode();

  // --- A: openchemlib (what main does today) ---
  // One SSSearcher, the fragment set once, then a parse and a graph match per candidate — exactly
  // src/utils/createVerifier.ts. `false` skips 2D-coordinate invention.
  const oclVerify = () => {
    const searcher = new OCL.SSSearcher();
    searcher.setFragment(query);
    const matches = [];
    for (let i = 0; i < candidates.length; i++) {
      searcher.setMolecule(OCL.Molecule.fromIDCode(candidates[i], false));
      if (searcher.isFragmentInMolecule()) matches.push(i);
    }
    return matches;
  };

  // --- B: openchemlib-search-wasm ---
  // The whole batch in one call, so the fragment is parsed once for the batch.
  const wasmVerify = () => substructureSearch(queryIdCode, candidates).indexes;

  const a = oclVerify();
  const b = wasmVerify();
  const identical = a.length === b.length && a.every((v, i) => v === b[i]);
  console.log(`${name} — ${a.length} matches, results identical: ${identical}`);
  if (!identical) throw new Error('the two implementations disagree; timing them is meaningless');

  const suite = new Benchmark.Suite();
  suite
    .add('openchemlib', oclVerify, { minSamples: 30 })
    .add('openchemlib-search-wasm', wasmVerify, { minSamples: 30 })
    .on('cycle', (event) => {
      const { name: caseName, stats, hz } = event.target;
      const perCandidate = (1e6 / hz / candidates.length).toFixed(2);
      console.log(
        `  ${caseName.padEnd(24)} ${(1000 / hz).toFixed(1).padStart(8)} ms/batch  ` +
          `${perCandidate.padStart(6)} µs/candidate  ±${stats.rme.toFixed(1)}%  (${stats.sample.length} runs)`,
      );
    })
    .on('complete', function onComplete() {
      const [ocl, wasm] = this.map((bench) => bench.hz);
      console.log(`  → wasm is ${(wasm / ocl).toFixed(2)}x openchemlib\n`);
    })
    .run();
}

// --- the fingerprint --------------------------------------------------------
// What indexing costs. `MoleculesDBSQLite.insert` builds one fingerprint per molecule, so the
// one-at-a-time form is the one that matters, and it is measured here per molecule.
const sample = candidates.slice(0, 200);
console.log(`FINGERPRINT — ${sample.length} molecules per call`);
const fingerprintSuite = new Benchmark.Suite();
fingerprintSuite
  .add(
    'openchemlib',
    () => {
      for (let i = 0; i < sample.length; i++) {
        OCL.Molecule.fromIDCode(sample[i], false).getIndex();
      }
    },
    { minSamples: 30 },
  )
  .add(
    'openchemlib-search-wasm',
    () => {
      for (let i = 0; i < sample.length; i++) getIndex(sample[i]);
    },
    { minSamples: 30 },
  )
  .on('cycle', (event) => {
    const { name, stats, hz } = event.target;
    console.log(
      `  ${name.padEnd(24)} ${(1e6 / hz / sample.length).toFixed(1).padStart(8)} µs/molecule  ` +
        `±${stats.rme.toFixed(1)}%  (${stats.sample.length} runs)`,
    );
  })
  .on('complete', function onComplete() {
    const [ocl, wasm] = this.map((bench) => bench.hz);
    console.log(`  → wasm is ${(wasm / ocl).toFixed(2)}x openchemlib`);
  })
  .run();
