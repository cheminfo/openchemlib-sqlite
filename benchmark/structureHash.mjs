// What the two structure hashes cost, and what the per-molecule cap buys.
//
// This is the measurement `backfillHashes()` is designed around. The two hashes
// are ~300x apart, which is why they run as separate passes with the cheap one
// first; and the tautomer hash's cost spans four orders of magnitude, with a
// handful of molecules dominating the total, which is why it needs a cap.
//
// Usage:
//   node --experimental-strip-types benchmark/structureHash.mjs <idcodes.txt> [sampleSize]
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import {
  NO_HASH,
  getNoStereoHash,
  getNoStereoTautomerHash,
  getNoStereoTautomerHashes,
} from 'openchemlib-search-wasm';

const FILE = process.argv[2];
const SAMPLE_SIZE = process.argv[3] ? Number(process.argv[3]) : 3000;
if (!FILE) {
  throw new Error('usage: tautomerHash.mjs <idcodes.txt> [sampleSize]');
}

// Spread the sample over the whole file: idcode dumps are usually ordered, and
// the first N molecules are not representative of the tail that matters here.
const all = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
const stride = Math.max(1, Math.floor(all.length / SAMPLE_SIZE));
const sample = [];
for (let i = 0; i < all.length && sample.length < SAMPLE_SIZE; i += stride) {
  sample.push(all[i]);
}

getNoStereoTautomerHash(sample[0]); // instantiate the wasm module

/**
 * Time one hash over the whole sample.
 * @param hashOne - The hash function to measure.
 * @returns Per-molecule timings, in ms, and how many had no hash.
 */
function measure(hashOne) {
  const times = new Float64Array(sample.length);
  let noHash = 0;
  for (let i = 0; i < sample.length; i++) {
    const start = performance.now();
    let hash = NO_HASH;
    try {
      hash = hashOne(sample[i]);
    } catch {
      // A malformed idcode throws rather than returning NO_HASH; both count.
    }
    times[i] = performance.now() - start;
    if (hash === NO_HASH) noHash++;
  }
  return { times, noHash };
}

// The cheap pass first, as the backfill runs them.
const cheap = measure(getNoStereoHash);
let cheapTotal = 0;
for (let i = 0; i < cheap.times.length; i++) cheapTotal += cheap.times[i];
const cheapSorted = Float64Array.from(cheap.times).sort();
console.log(
  `no-stereo hash:        mean ${((cheapTotal / cheap.times.length) * 1000).toFixed(0)} µs   p50 ${(cheapSorted[Math.floor(cheapSorted.length * 0.5)] * 1000).toFixed(0)} µs   p99 ${(cheapSorted[Math.floor(cheapSorted.length * 0.99)] * 1000).toFixed(0)} µs   max ${(cheapSorted.at(-1) * 1000).toFixed(0)} µs`,
);
console.log(
  `400k entries, 1 core:  ${((cheapTotal / cheap.times.length * 400_000) / 1000).toFixed(0)} s\n`,
);

const { times, noHash } = measure(getNoStereoTautomerHash);

const sorted = Float64Array.from(times).sort();
const percentile = (p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
let total = 0;
for (let i = 0; i < times.length; i++) total += times[i];

console.log(`\nno-stereo tautomer hash, ${sample.length} idcodes, ${noHash} with no hash\n`);
console.log(`mean ${(total / times.length).toFixed(2)} ms/molecule\n`);
for (const p of [0.5, 0.9, 0.99, 0.999]) {
  console.log(
    `  p${(p * 100).toFixed(1).padStart(5)} ${(percentile(p) * 1000).toFixed(0).padStart(9)} µs`,
  );
}
console.log(`  max   ${(sorted.at(-1) * 1000).toFixed(0).padStart(9)} µs`);

// What a cap costs and saves. A capped molecule still costs the cap, plus the
// ~50 ms of destroying its worker and starting a fresh one.
const RESTART_MS = 50;
const cores = availableParallelism();
console.log(
  `\n  cap    given up      mean/mol   400k entries, 1 core   ${String(cores).padStart(2)} cores`,
);
for (const cap of [Infinity, 250, 100, 50, 20]) {
  let capped = 0;
  let gaveUp = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] > cap) {
      capped += cap + RESTART_MS;
      gaveUp++;
    } else {
      capped += times[i];
    }
  }
  const perMolecule = capped / times.length;
  const seconds = (perMolecule * 400_000) / 1000;
  const format = (s) =>
    s > 3600
      ? `${(s / 3600).toFixed(1)} h`
      : s > 60
        ? `${(s / 60).toFixed(1)} min`
        : `${s.toFixed(0)} s`;
  console.log(
    `${(cap === Infinity ? '  none' : `${cap} ms`).padStart(6)}  ${String(gaveUp).padStart(5)} (${((gaveUp / times.length) * 100).toFixed(2).padStart(5)}%)  ${perMolecule.toFixed(2).padStart(8)} ms  ${format(seconds).padStart(19)}  ${format(seconds / cores).padStart(9)}`,
  );
}

// A per-molecule cap means hashing one molecule at a time, so the batched call
// had better not be cheaper — this is what makes the cap affordable at all.
const quick = [];
for (let i = 0; i < times.length && quick.length < 500; i++) {
  if (times[i] < 5) quick.push(sample[i]);
}
let start = performance.now();
for (let i = 0; i < quick.length; i++) getNoStereoTautomerHash(quick[i]);
const oneByOne = performance.now() - start;
start = performance.now();
getNoStereoTautomerHashes(quick);
const batched = performance.now() - start;
console.log(
  `\non ${quick.length} fast molecules: one-by-one ${((oneByOne * 1000) / quick.length).toFixed(0)} µs/mol, batched ${((batched * 1000) / quick.length).toFixed(0)} µs/mol`,
);
