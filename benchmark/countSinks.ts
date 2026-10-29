// The count's sinks, over synthetic blocks of 2^20 and 2^26 rows (the second far beyond the
// caches), every case through the production kernel and sinks, in one process:
//   total: the count alone, every row;
//   E: byKeys of 534 keys, on every row (read plane by plane), on 0.1 % and on 0.01 % of the rows
//      (only the words kept read);
//   F: membershipOf 16 sets (by combination) and 32 sets (by how many);
//   G: a histogram (100 bins) of an int16 and of a float32 column.
// The 534 keys are laid round-robin over 64 distinct planes: 512 MB at 2^26 rows instead of 4.3 GB.
// Prints each case's total, then mean ms, ns per row and rme.
//
//   node benchmark/countSinks.ts [log2 rows ...]   (default: 20 26)
//   bun benchmark/countSinks.ts [log2 rows ...]
import type { BlockViews, ColumnLayout } from '../src/search/blocks.ts';
import type { CountTally } from '../src/search/pool/countSink.ts';
import { newTally, tallyBlock } from '../src/search/pool/countSink.ts';
import type { CountPhase } from '../src/search/pool/messages.ts';
import type { ScreenContext } from '../src/search/pool/screenKernel.ts';
import { screenWords } from '../src/search/pool/screenKernel.ts';
import { setWords } from '../src/search/pool/setWords.ts';

import type { BenchCase } from './benchSuite.ts';
import { entriesOver, randomWords, runCases } from './benchSuite.ts';

const DISTINCT_PLANES = 64;
const KEYS = 534;
const LAYOUT: ColumnLayout = {
  rowBytes: 0,
  seqAt: 0,
  fragFpBitsAt: 0,
  screenBitsAt: 0,
  functionBitsAt: 0,
  filters: [
    { name: 'int16', type: 'int16', at: 0 },
    { name: 'float32', type: 'float32', at: 0 },
  ],
};

const sizes = process.argv.slice(2).map(Number);
for (const log2 of sizes.length > 0 ? sizes : [20, 26]) {
  // eslint-disable-next-line no-await-in-loop -- one size after the other, each in its own memory
  await runCases(`count sinks, 2^${log2} rows`, casesOf(2 ** log2));
}

/**
 * The cases of one size, over one synthetic block.
 * @param rows - The block's rows.
 * @returns The cases.
 */
function casesOf(rows: number): BenchCase[] {
  const W = rows / 32;
  const planes = new Int32Array(DISTINCT_PLANES * W);
  for (let p = 0; p < DISTINCT_PLANES; p++) {
    planes.set(randomWords(W, 0.3, p + 1), p * W);
  }
  const int16 = new Int16Array(rows);
  const float32 = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    int16[r] = (r * 7919) % 1000;
    float32[r] = ((r * 104_729) % 100_000) / 100_000;
  }
  const view = {
    planes,
    W,
    key: new Float64Array(0),
    seq: new Uint32Array(0),
    filters: [int16, float32],
  } as unknown as BlockViews;
  const bitmap = (density: number, seed: number) => {
    const buffer = new SharedArrayBuffer(4 * W);
    new Int32Array(buffer).set(randomWords(W, density, seed));
    return buffer;
  };
  const all = new SharedArrayBuffer(4 * W);
  new Int32Array(all).fill(-1);
  const members = Array.from({ length: 32 }, (_, i) => bitmap(0.5, 100 + i));
  const keys = Int32Array.from({ length: KEYS }, (_, k) => k % DISTINCT_PLANES);
  const entries = entriesOver(W);
  const nEntries = entries.length / 4;
  const count = (
    name: string,
    restriction: SharedArrayBuffer,
    fields: Partial<CountPhase>,
  ): BenchCase => {
    const sets = setWords({ alive: restriction, any: null, all: [], none: [] });
    const context = contextOf(view, sets);
    const tally = tallyOf(fields, view);
    return {
      name,
      rows,
      run: () => {
        tally.tallies.fill(0);
        screenWords(context, entries, 0, nEntries, null, tally, true);
        return tally.tallies[0] as number;
      },
    };
  };
  return [
    count('total', all, {}),
    count('E byKeys 534, every row', all, { byKeys: keys }),
    count('E byKeys 534, 0.1 %', bitmap(0.001, 7), { byKeys: keys }),
    count('E byKeys 534, 0.01 %', bitmap(0.0001, 8), { byKeys: keys }),
    count('F membershipOf 16', all, { membership: members.slice(0, 16) }),
    count('F membershipOf 32', all, { membership: members }),
    count('G histogram, int16', all, {
      histogram: { column: 0, min: 0, width: 10, bins: 100 },
    }),
    count('G histogram, float32', all, {
      histogram: { column: 1, min: 0, width: 0.01, bins: 100 },
    }),
  ];
}

/**
 * A count's context over the block: no plane, the set as the restriction.
 * @param view - The block.
 * @param sets - The set expression.
 * @returns The context.
 */
function contextOf(
  view: BlockViews,
  sets: ReturnType<typeof setWords>,
): ScreenContext {
  return {
    planes: view.planes,
    poff: new Int32Array(0),
    flip: new Int32Array(0),
    restrictionAt: 0,
    sets,
    single: sets.single,
    aoff: new Int32Array(0),
    anyCount: 0,
    base: 0,
    kBase: 0,
    seq: view.seq,
    key: view.key,
    lo: -Infinity,
    hi: Infinity,
    end: Infinity,
    cursorKey: -Infinity,
    cursorId: -1,
    keep: null,
  };
}

/**
 * The tallies of a count asking for some sinks.
 * @param fields - The sinks.
 * @param view - The block.
 * @returns The tallies, started on the block.
 */
function tallyOf(fields: Partial<CountPhase>, view: BlockViews): CountTally {
  const membership = fields.membership ?? [];
  const histogram = fields.histogram ?? null;
  const n = membership.length;
  const phase = {
    bySets: [],
    byKeys: fields.byKeys ?? new Int32Array(0),
    membership,
    histogram,
    tallies:
      1 +
      (fields.byKeys?.length ?? 0) +
      (n === 0 ? 0 : n <= 16 ? 2 ** n : n + 1) +
      (histogram === null ? 0 : histogram.bins + 3),
  } as unknown as CountPhase;
  const tally = newTally(phase, () => undefined);
  tallyBlock(tally, view, LAYOUT, 0);
  return tally;
}
