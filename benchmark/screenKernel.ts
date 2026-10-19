// The screen kernel, A/B in one process on the same synthetic block of 2^20 rows: 8 query planes
// (densities 0.15 to 0.9), the restriction word after the first two.
//   A: the kernel before set expressions, reading one restriction array;
//   B: the new kernel with `single` set (one bitmap, no flip, no OR group);
//   C: the new kernel with a 3-set expression (any 2, none 1) and an OR group of 3 keys;
//   D: the new kernel with 4 key planes besides the query's, 2 to hold and 2 to lack.
// Each case has its own function (benchmark/screenKernelCopies.ts). Prints each case's candidates,
// then mean ms, ns per row and rme.
//
//   node benchmark/screenKernel.ts
//   bun benchmark/screenKernel.ts
import type {
  Collected,
  ScreenContext,
} from '../src/search/pool/screenKernel.ts';
import { screenWords } from '../src/search/pool/screenKernel.ts';
import { setWords } from '../src/search/pool/setWords.ts';
import type { SetExpression } from '../src/search/setExpression.ts';

import { entriesOver, randomWords, runCases } from './benchSuite.ts';
import type { OldScreenContext } from './screenKernelCopies.ts';
import {
  oldScreenWords,
  screenWordsC,
  screenWordsD,
} from './screenKernelCopies.ts';

const ROWS = 2 ** 20;
const W = ROWS / 32;
const QUERY = [0.15, 0.3, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9];
// Planes 0-7 the query's, 8-10 the OR group's, 11-12 keys to hold, 13-14 keys to lack.
const DENSITIES = [...QUERY, 0.3, 0.3, 0.3, 0.6, 0.6, 0.1, 0.1];
const planes = new Int32Array(DENSITIES.length * W);
for (const [p, density] of DENSITIES.entries()) {
  planes.set(randomWords(W, density, p + 1), p * W);
}
const bitmap = (density: number, seed: number) => {
  const buffer = new SharedArrayBuffer(4 * W);
  new Int32Array(buffer).set(randomWords(W, density, seed));
  return buffer;
};
const restriction = bitmap(0.7, 101);
const key = new Float64Array(ROWS);
for (let r = 0; r < ROWS; r++) key[r] = (r * 7919) % 1000;
const seq = Uint32Array.from({ length: ROWS }, (_, r) => r + 1);
const entries = entriesOver(W);
const nEntries = entries.length / 4;
const out: Collected = {
  n: 0,
  key: new Float64Array(1024),
  id: new Float64Array(1024),
};
const offsets = (list: number[]) => Int32Array.from(list, (p) => p * W);
const shared = {
  planes,
  base: 0,
  kBase: 0,
  seq,
  key,
  lo: -Infinity,
  hi: Infinity,
  end: Infinity,
  cursorKey: -Infinity,
  cursorId: -1,
  keep: null,
};
const query = [0, 1, 2, 3, 4, 5, 6, 7];
const old: OldScreenContext = {
  ...shared,
  poff: offsets(query),
  restrictionAt: 2,
  restr: new Int32Array(restriction),
};
const single = setWords({
  alive: restriction,
  any: [restriction],
  all: [],
  none: [],
});
const plain: ScreenContext = {
  ...shared,
  poff: offsets(query),
  flip: new Int32Array(query.length),
  restrictionAt: 2,
  sets: single,
  single: single.single,
  aoff: new Int32Array(0),
  anyCount: 0,
};
const expression: SetExpression = {
  alive: restriction,
  any: [bitmap(0.4, 102), bitmap(0.4, 103)],
  all: [],
  none: [bitmap(0.1, 104)],
};
const three = setWords(expression);
const grouped: ScreenContext = {
  ...plain,
  sets: three,
  single: three.single,
  aoff: offsets([8, 9, 10]),
  anyCount: 3,
};
// The key planes by survival: the lacked ones keep 90 % of the rows, the held ones 60 %.
const keyed: ScreenContext = {
  ...plain,
  poff: offsets([0, 1, 2, 3, 11, 12, 4, 5, 6, 7, 13, 14]),
  flip: Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1]),
};

await runCases('screen kernel, 2^20 rows', [
  {
    name: 'A old kernel, one restriction array',
    rows: ROWS,
    run: () => {
      out.n = 0;
      oldScreenWords(old, entries, 0, nEntries, out);
      return out.n;
    },
  },
  {
    name: 'B new kernel, single set',
    rows: ROWS,
    run: () => {
      out.n = 0;
      screenWords(plain, entries, 0, nEntries, out, null, false);
      return out.n;
    },
  },
  {
    name: 'C new kernel, any 2 none 1, OR group of 3',
    rows: ROWS,
    run: () => {
      out.n = 0;
      screenWordsC(grouped, entries, 0, nEntries, out, null, false);
      return out.n;
    },
  },
  {
    name: 'D new kernel, 4 key planes with flips',
    rows: ROWS,
    run: () => {
      out.n = 0;
      screenWordsD(keyed, entries, 0, nEntries, out, null, false);
      return out.n;
    },
  },
]);
