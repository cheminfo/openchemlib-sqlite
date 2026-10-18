// Similarity page latency per fingerprint ('fragFp', 'screen', 'both'), in one process on one
// index: each query's first page timed with benchmark.js, the three fingerprints interleaved.
// Prints the rows, each case's first page (hits, total, rows scored), then mean ms, ns per row and
// rme per case.
//
//   node benchmark/similarity.ts <db.sqlite> [threads]
//
// The database is one benchmark/buildStore.ts made (the tests' application schema).
import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { SPEC } from '../src/__tests__/testDatabase.ts';
import type { SimilarityFingerprint } from '../src/moleculeIndex.ts';
import { MoleculeIndex } from '../src/moleculeIndex.ts';

const [file, threads = process.env.WORKER_THREADS ?? '2'] =
  process.argv.slice(2);
if (file === undefined) {
  throw new Error('usage: node benchmark/similarity.ts <db.sqlite> [threads]');
}
const index = await MoleculeIndex.open(file, SPEC, {
  threads: Number(threads),
  follow: false,
});
process.stdout.write(
  `${JSON.stringify({ rows: index.rowCount, threads: Number(threads) })}\n`,
);

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const QUERIES: Array<[string, string]> = [
  ['aspirin', smiles('CC(=O)Oc1ccccc1C(=O)O')],
  ['caffeine', smiles('Cn1cnc2c1c(=O)n(C)c(=O)n2C')],
  ['flavone', smiles('O=c1cc(-c2ccccc2)oc2ccccc12')],
];
const FINGERPRINTS: SimilarityFingerprint[] = ['fragFp', 'screen', 'both'];
const cases: Array<[string, () => ReturnType<MoleculeIndex['similarity']>]> =
  [];
for (const [name, query] of QUERIES) {
  for (const threshold of [0.8, 0.6]) {
    for (const fingerprint of FINGERPRINTS) {
      cases.push([
        `${name} ${threshold} ${fingerprint}`,
        () =>
          index.similarity(query, {
            threshold,
            fingerprint,
            limit: 24,
            budgetMs: 60_000,
          }),
      ]);
    }
  }
}

// The computed values first.
for (const [label, run] of cases) {
  // eslint-disable-next-line no-await-in-loop -- one query at a time, as the pool runs them
  const page = await run();
  process.stdout.write(
    `${label}: ${page.hits.length} hits, total ${page.total}, scored ${page.info.scored}, best ${page.hits[0]?.score.toFixed(3) ?? '-'}\n`,
  );
}

const suite = new Benchmark.Suite();
for (const [label, run] of cases) {
  suite.add(label, {
    defer: true,
    minSamples: 30,
    fn: (deferred: { resolve: () => void }) => {
      void run().then(() => deferred.resolve());
    },
  });
}
suite.on(
  'cycle',
  (event: {
    target: { name: string; stats: { mean: number; rme: number } };
  }) => {
    const { name, stats } = event.target;
    const ms = stats.mean * 1000;
    const nsPerRow = (stats.mean * 1e9) / index.rowCount;
    process.stdout.write(
      `${name}: ${ms.toFixed(2)} ms, ${nsPerRow.toFixed(1)} ns/row ±${stats.rme.toFixed(1)}%\n`,
    );
  },
);
await new Promise((resolve) => {
  suite.on('complete', resolve);
  suite.run({ async: true });
});
await index.close();
