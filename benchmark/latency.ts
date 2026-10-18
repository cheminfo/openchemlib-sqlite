// Page latency of MoleculeIndex, A/B in one process on one file: two indexes over the same
// database (A: the defaults; B: one option changed), each query's first page timed with
// benchmark.js, interleaved. Prints the load times, each query's first page on both sides (they
// must agree), then mean ms and rme per case.
//
//   node benchmark/latency.ts <db.sqlite> [threads] [option=value for B, default firstSliceRows=16384]
//
// The database is one benchmark/buildStore.ts made (the tests' application schema).
import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { SPEC } from '../src/__tests__/testDatabase.ts';
import type { MoleculeIndexOptions } from '../src/moleculeIndex.ts';
import { MoleculeIndex } from '../src/moleculeIndex.ts';

const [file, threads = '4', change = 'firstSliceRows=16384'] =
  process.argv.slice(2);
if (file === undefined) {
  throw new Error(
    'usage: node benchmark/latency.ts <db.sqlite> [threads] [option=value]',
  );
}
const [name, value] = change.split('=') as [string, string];
const base: MoleculeIndexOptions = { threads: Number(threads), follow: false };
const variant = {
  ...base,
  [name]: Number.isNaN(Number(value)) ? value : Number(value),
};
let at = performance.now();
const a = await MoleculeIndex.open(file, SPEC, base);
const loadA = performance.now() - at;
at = performance.now();
const b = await MoleculeIndex.open(file, SPEC, variant);
const loadB = performance.now() - at;
process.stdout.write(
  `${JSON.stringify({ rows: a.rowCount, loadAMs: Math.round(loadA), loadBMs: Math.round(loadB), b: change })}\n`,
);

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const queries: Array<[string, (index: MoleculeIndex) => Promise<unknown>]> = [
  ['benzene', (index) => index.substructure(smiles('c1ccccc1'), { limit: 24 })],
  [
    'steroid',
    (index) =>
      index.substructure(smiles('C1CCC2C(C1)CCC1C2CCC2CCCC12'), { limit: 24 }),
  ],
  [
    'cubane',
    (index) => index.substructure(smiles('C12C3C4C1C5C2C3C45'), { limit: 24 }),
  ],
  [
    'benzene, logP >= 2, key 300-400',
    (index) =>
      index.substructure(smiles('c1ccccc1'), {
        limit: 24,
        keyMin: 300,
        keyMax: 400,
        filters: { logP: { min: 2 } },
      }),
  ],
  [
    'browse, source B',
    (index) => index.browse({ limit: 24, sets: ['source:2'] }),
  ],
  [
    'similarity aspirin 0.6',
    (index) =>
      index.similarity(smiles('CC(=O)Oc1ccccc1C(=O)O'), {
        threshold: 0.6,
        limit: 24,
      }),
  ],
];
// The computed values first: both sides must answer the same first page.
for (const [label, run] of queries) {
  // eslint-disable-next-line no-await-in-loop -- one query at a time, as the pool runs them
  const [pageA, pageB] = [await run(a), await run(b)].map((page) =>
    JSON.stringify((page as { hits: unknown[] }).hits),
  );
  const hits = (JSON.parse(pageA as string) as unknown[]).length;
  process.stdout.write(
    `${label}: ${hits} hits, same on B: ${pageA === pageB}\n`,
  );
}
const suite = new Benchmark.Suite();
for (const [label, run] of queries) {
  for (const [side, index] of [
    ['A', a],
    ['B', b],
  ] as const) {
    suite.add(`${side} ${label}`, {
      defer: true,
      minSamples: 30,
      fn: (deferred: { resolve: () => void }) => {
        void run(index).then(() => deferred.resolve());
      },
    });
  }
}
suite.on(
  'cycle',
  (event: {
    target: {
      name: string;
      stats: { mean: number; rme: number };
      result?: unknown;
    };
  }) => {
    const { name: caseName, stats } = event.target;
    process.stdout.write(
      `${caseName}: ${(stats.mean * 1000).toFixed(2)} ms ±${stats.rme.toFixed(1)}%\n`,
    );
  },
);
await new Promise((resolve) => {
  suite.on('complete', resolve);
  suite.run({ async: true });
});
await a.close();
await b.close();
