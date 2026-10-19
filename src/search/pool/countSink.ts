import { popcount32 } from '../../chemistry/bits.ts';
import type { BlockViews, ColumnLayout } from '../blocks.ts';

import type { CountPhase, HistogramTask } from './messages.ts';
import type { ExactRow } from './rowFilter.ts';
import {
  FLOAT,
  INT16,
  INT32,
  tallyHistogram,
  tallyMembership,
} from './rowSinks.ts';

/**
 * What one worker tallies over the rows a count answers, in the layout of the count: the total,
 * then one entry per set of `bySets`, per key of `byKeys`, then the membership (by combination for
 * 16 sets or fewer, by how many sets above), then the histogram (below, the bins, above, missing).
 */
export interface CountTally {
  tallies: Float64Array;
  /** `bySets`: each set's words (null for an unknown name), and where their entries start. */
  setMaps: Array<Int32Array | null>;
  setsAt: number;
  /** `byKeys`: their planes, and where their entries start. */
  keyPlanes: Int32Array;
  keysAt: number;
  /** The words the entry under way kept, their words in the block, and how many. */
  keptWords: Int32Array;
  keptAt: Int32Array;
  kept: number;
  /** The kept words laid at their place in the entry, when it is read plane by plane. */
  dense: Int32Array;
  /** `membershipOf`: each set's words (null for an unknown name), where its entries start. */
  memberMaps: Array<Int32Array | null>;
  memberAt: number;
  /** Whether rows are counted by combination (16 sets or fewer), else by how many sets. */
  combinations: boolean;
  /** One word per set of `membershipOf`, reused from word to word. */
  member: Int32Array;
  histogram: HistogramTask | null;
  histogramAt: number;
  /** The block under way: its planes, words per plane, the histogram's column and its kind. */
  planes: Int32Array;
  W: number;
  values: Float64Array | Float32Array | Int32Array | Int16Array;
  kind: number;
  kBase: number;
  seq: Uint32Array;
  exact: ExactRow;
}

/**
 * The tallies of a count phase, all at zero.
 * @param m - The phase.
 * @param exact - Reads a row's exact values (a saturated int of the histogram's column).
 * @returns The tallies.
 */
export function newTally(m: CountPhase, exact: ExactRow): CountTally {
  const memberCount = m.membership.length;
  const setsAt = 1;
  const keysAt = setsAt + m.bySets.length;
  const memberAt = keysAt + m.byKeys.length;
  const combinations = memberCount <= 16;
  const memberSize =
    memberCount === 0 ? 0 : combinations ? 2 ** memberCount : memberCount + 1;
  return {
    tallies: new Float64Array(m.tallies),
    setMaps: viewsOf(m.bySets),
    setsAt,
    keyPlanes: m.byKeys,
    keysAt,
    keptWords: new Int32Array(2048),
    keptAt: new Int32Array(2048),
    kept: 0,
    dense: new Int32Array(2048),
    memberMaps: viewsOf(m.membership),
    memberAt,
    combinations,
    member: new Int32Array(Math.max(1, memberCount)),
    histogram: m.histogram,
    histogramAt: memberAt + memberSize,
    planes: new Int32Array(0),
    W: 0,
    values: new Float64Array(0),
    kind: FLOAT,
    kBase: 0,
    seq: new Uint32Array(0),
    exact,
  };
}

/**
 * Starts a block: the planes `byKeys` reads, and the column the histogram bins.
 * @param t - The tallies.
 * @param view - The block's views.
 * @param layout - The column layout.
 * @param kBase - The block's atom count times 2^36.
 */
export function tallyBlock(
  t: CountTally,
  view: BlockViews,
  layout: ColumnLayout,
  kBase: number,
): void {
  t.planes = view.planes;
  t.W = view.W;
  t.kBase = kBase;
  t.seq = view.seq;
  const column = t.histogram?.column ?? -1;
  if (column < 0) {
    t.values = view.key;
    t.kind = FLOAT;
    return;
  }
  t.values = view.filters[column] as CountTally['values'];
  const type = layout.filters[column]?.type;
  t.kind = type === 'int32' ? INT32 : type === 'int16' ? INT16 : FLOAT;
}

/**
 * Tallies the rows of one word the count keeps.
 * @param t - The tallies.
 * @param g - The word, in the row space.
 * @param w - The word, in the block.
 * @param word - Its rows, one bit each.
 */
export function tallyWord(
  t: CountTally,
  g: number,
  w: number,
  word: number,
): void {
  const { tallies, setMaps, setsAt, keyPlanes, memberMaps, histogram } = t;
  tallies[0] = (tallies[0] as number) + popcount32(word);
  for (let s = 0; s < setMaps.length; s++) {
    const map = setMaps[s];
    if (map === null || map === undefined) continue;
    tallies[setsAt + s] =
      (tallies[setsAt + s] as number) + popcount32(word & (map[g] as number));
  }
  if (keyPlanes.length > 0) keep(t, w, word);
  if (memberMaps.length > 0) tallyMembership(t, g, word);
  if (histogram !== null) tallyHistogram(t, w, word);
}

/**
 * The key planes read for the words an entry kept, then forgotten: only those words of each plane
 * when they are fewer than a sixteenth of the entry (a sparse subset), else every word of the
 * entry, plane after plane, so each plane is read in order.
 * @param t - The tallies.
 * @param w0 - The entry's first word.
 * @param w1 - Its end word.
 */
export function flushKeys(t: CountTally, w0: number, w1: number): void {
  const n = t.kept;
  if (n === 0) return;
  t.kept = 0;
  const { keyPlanes, planes, W, tallies, keysAt, keptWords, keptAt } = t;
  if (n < (w1 - w0) / 16) {
    for (let k = 0; k < keyPlanes.length; k++) {
      const at = (keyPlanes[k] as number) * W;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += popcount32(
          (planes[at + (keptAt[i] as number)] as number) &
            (keptWords[i] as number),
        );
      }
      tallies[keysAt + k] = (tallies[keysAt + k] as number) + sum;
    }
    return;
  }
  const span = w1 - w0;
  if (t.dense.length < span) t.dense = new Int32Array(span);
  const dense = t.dense;
  dense.fill(0, 0, span);
  for (let i = 0; i < n; i++) {
    dense[(keptAt[i] as number) - w0] = keptWords[i] as number;
  }
  for (let k = 0; k < keyPlanes.length; k++) {
    const at = (keyPlanes[k] as number) * W + w0;
    let sum = 0;
    for (let j = 0; j < span; j++) {
      sum += popcount32((planes[at + j] as number) & (dense[j] as number));
    }
    tallies[keysAt + k] = (tallies[keysAt + k] as number) + sum;
  }
}

function keep(t: CountTally, w: number, word: number): void {
  if (t.kept === t.keptWords.length) {
    const words = new Int32Array(2 * t.kept);
    const at = new Int32Array(2 * t.kept);
    words.set(t.keptWords);
    at.set(t.keptAt);
    t.keptWords = words;
    t.keptAt = at;
  }
  t.keptWords[t.kept] = word;
  t.keptAt[t.kept++] = w;
}

function viewsOf(
  buffers: ReadonlyArray<SharedArrayBuffer | null>,
): Array<Int32Array | null> {
  const out = new Array<Int32Array | null>(buffers.length);
  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];
    out[i] =
      buffer === null || buffer === undefined ? null : new Int32Array(buffer);
  }
  return out;
}
