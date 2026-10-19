import Benchmark from 'benchmark';
import { XSadd } from 'ml-xsadd';

/** One case of a benchmark: what it measures, over how many rows, and the value it computes. */
export interface BenchCase {
  name: string;
  rows: number;
  /** Runs the case once and returns what it computed, printed so cases can be compared. */
  run: () => number;
}

/**
 * Runs cases with benchmark.js, interleaved in one process (30 samples at least): prints each
 * case's computed value first, then its mean, its ns per row and its rme.
 * @param title - What the benchmark is.
 * @param cases - The cases.
 * @returns Once every case ran.
 */
export async function runCases(
  title: string,
  cases: readonly BenchCase[],
): Promise<void> {
  const runtime =
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? `node ${process.version}`
      : 'bun';
  process.stdout.write(`${title} (${runtime})\n`);
  for (const { name, run } of cases) {
    process.stdout.write(`${name}: computes ${run()}\n`);
  }
  const suite = new Benchmark.Suite();
  for (const { name, run } of cases) suite.add(name, run, { minSamples: 30 });
  const rowsOf = new Map(cases.map((entry) => [entry.name, entry.rows]));
  suite.on(
    'cycle',
    (event: {
      target: { name: string; stats: { mean: number; rme: number } };
    }) => {
      const { name, stats } = event.target;
      const rows = rowsOf.get(name) as number;
      process.stdout.write(
        `${name}: ${(stats.mean * 1000).toFixed(3)} ms, ${((stats.mean * 1e9) / rows).toFixed(3)} ns/row ±${stats.rme.toFixed(1)}%\n`,
      );
    },
  );
  await new Promise((resolve) => {
    suite.on('complete', resolve);
    suite.run({ async: true });
  });
}

/**
 * Seeded words whose bits are each set with a probability: above 1/16, built from uniform words
 * (an OR or an AND per binary digit of the probability, 6 of them); below, that share of the bits
 * set at drawn places.
 * @param words - How many words.
 * @param density - The probability of each bit.
 * @param seed - The seed.
 * @returns The words.
 */
export function randomWords(
  words: number,
  density: number,
  seed: number,
): Int32Array {
  const random = new XSadd(seed);
  const out = new Int32Array(words);
  if (density < 1 / 16) {
    const bits = Math.round(density * 32 * words);
    for (let i = 0; i < bits; i++) {
      const at = Math.floor(random.getFloat() * 32 * words);
      out[at >>> 5] = (out[at >>> 5] as number) | (1 << (at & 31));
    }
    return out;
  }
  const digits = Math.round(density * 64);
  for (let w = 0; w < words; w++) {
    let word = 0;
    for (let d = 0; d < 6; d++) {
      const r = random.getUint32() | 0;
      word = ((digits >> d) & 1) === 1 ? word | r : word & r;
    }
    out[w] = word;
  }
  return out;
}

/**
 * Work entries over [0, words) of one block, 2,048 words each, as a slice of a walk cuts them.
 * @param words - The block's words.
 * @returns (block, first word, end word, last mask) quadruples.
 */
export function entriesOver(words: number): Float64Array {
  const entries: number[] = [];
  for (let w = 0; w < words; w += 2048) {
    entries.push(0, w, Math.min(words, w + 2048), -1);
  }
  return Float64Array.from(entries);
}
