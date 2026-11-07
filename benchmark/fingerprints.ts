// FragFp of molecules by id: read from the index's bit planes (`index.fingerprints`) against
// computed again from their idCodes (`getIndexes`, what an application had to do before), in one
// process on the same molecules, drawn at random. Prints each case's checksum (the bits set over
// all the words, the same for both), then mean ms, ns per molecule and rme.
//
//   node benchmark/fingerprints.ts <db.sqlite> [molecules]
//
// The database is one benchmark/buildStore.ts made (the tests' application schema).
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import { XSadd } from 'ml-xsadd';
import { getIndexes } from 'openchemlib-search-wasm';

import { SPEC } from '../src/__tests__/testDatabase.ts';
import { MoleculeIndex } from '../src/moleculeIndex.ts';

const [file, wanted = '10000'] = process.argv.slice(2);
if (file === undefined) {
  throw new Error(
    'usage: node benchmark/fingerprints.ts <db.sqlite> [molecules]',
  );
}
const db = new DatabaseSync(file, { readOnly: true });
const all = db
  .prepare('SELECT id, idCode FROM ocl_molecule ORDER BY id')
  .all() as Array<{ id: number; idCode: string }>;
db.close();
const random = new XSadd(17);
const picked = all
  .map((row) => ({ row, order: random.random() }))
  .toSorted((a, b) => a.order - b.order)
  .slice(0, Number(wanted))
  .map(({ row }) => row);
const ids = picked.map((row) => row.id);
const idCodes = picked.map((row) => row.idCode);

const index = await MoleculeIndex.open(file, SPEC, {
  threads: 1,
  follow: false,
});
process.stdout.write(
  `${JSON.stringify({ rows: index.rowCount, molecules: ids.length })} (node ${process.version})\n`,
);

/**
 * The bits set over words, so both cases can be seen to agree.
 * @param words - The words.
 * @returns How many bits they set.
 */
function bitsSet(words: Int32Array): number {
  let count = 0;
  // A checksum printed once, outside the timed cases.
  for (const word of words) {
    let value = word >>> 0;
    while (value !== 0) {
      value &= value - 1;
      count++;
    }
  }
  return count;
}

/**
 * The FragFp of every molecule, computed again from its idCode.
 * @returns Their words, 16 each.
 */
function recompute(): Int32Array {
  const words = new Int32Array(16 * idCodes.length);
  const computed = getIndexes(idCodes);
  for (let at = 0; at < computed.length; at++) {
    words.set(computed[at] as Int32Array, 16 * at);
  }
  return words;
}

const read = await index.fingerprints(ids);
process.stdout.write(`read from the index: ${bitsSet(read.words)} bits set\n`);
process.stdout.write(
  `computed from the idCode: ${bitsSet(recompute())} bits set\n`,
);

const suite = new Benchmark.Suite();
suite.add('read from the index', {
  defer: true,
  minSamples: 30,
  fn: (deferred: { resolve: () => void }) => {
    void index.fingerprints(ids).then(() => deferred.resolve());
  },
});
suite.add('computed from the idCode', {
  minSamples: 30,
  fn: () => recompute(),
});
suite.on(
  'cycle',
  (event: {
    target: { name: string; stats: { mean: number; rme: number } };
  }) => {
    const { name, stats } = event.target;
    process.stdout.write(
      `${name}: ${(stats.mean * 1000).toFixed(2)} ms, ${((stats.mean * 1e9) / ids.length).toFixed(0)} ns per molecule ±${stats.rme.toFixed(1)}%\n`,
    );
  },
);
await new Promise((resolve) => {
  suite.on('complete', resolve);
  suite.run({ async: true });
});
await index.close();
