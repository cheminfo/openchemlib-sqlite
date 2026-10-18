import { keepTop } from './bitSlices.ts';

/** What the similarity scan of one block reads. */
export interface SimilarityContext {
  planes: Int32Array;
  /** Where each query plane starts in the block's planes. */
  poff: Int32Array;
  restr: Int32Array;
  base: number;
  kBase: number;
  seq: Uint32Array;
  /** Each row's bit count in the fingerprint scored: `bits`, plus `bits2` when it is `both`. */
  bits: Uint16Array;
  bits2: Uint16Array | null;
  /** Per word, the least and the largest of those counts. */
  zoneMin: Uint16Array;
  zoneMax: Uint16Array;
  /** The bit-count window, the threshold, the query's bit count. */
  low: number;
  high: number;
  threshold: number;
  qBits: number;
  /** The least shared count a row of the window passes with, and qBits − mMin. */
  mMin: number;
  D: number;
  keep: ((row: number, id: number) => boolean) | null;
}

/** What one unit's scan found: counts and the best rows after the cursor. */
export interface SimilarityTally {
  /** Rows whose Tanimoto was computed: inside the bit-count window and the filters. */
  scored: number;
  matched: number;
  afterCount: number;
  kept: number;
  hasAfter: boolean;
  afterScore: number;
  afterId: number;
  topId: Float64Array;
  topScore: Float64Array;
}

/**
 * A lane whose shared count reaches mMin: inside the bit-count window and the filters, it is
 * scored; reaching the threshold, it is counted, and kept when it ranks after the cursor among the
 * best.
 * @param c - The block's context.
 * @param res - The unit's tally, updated.
 * @param r - The lane's row in the block.
 * @param shared - The bits it shares with the query.
 */
export function scoreLane(
  c: SimilarityContext,
  res: SimilarityTally,
  r: number,
  shared: number,
): void {
  const b =
    c.bits2 === null
      ? (c.bits[r] as number)
      : (c.bits[r] as number) + (c.bits2[r] as number);
  if (b < c.low || b > c.high) return;
  const id = c.kBase + (c.seq[r] as number);
  if (c.keep !== null && !c.keep(r, id)) return;
  res.scored++;
  const score = shared / (c.qBits + b - shared);
  if (!(score >= c.threshold)) return;
  res.matched++;
  if (
    res.hasAfter &&
    !(res.afterScore > score || (res.afterScore === score && res.afterId < id))
  ) {
    return;
  }
  res.afterCount++;
  res.kept = keepTop(res.topId, res.topScore, res.kept, id, score);
}
