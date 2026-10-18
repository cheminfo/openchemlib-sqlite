import { atLeast, laneCount } from './bitSlices.ts';
import type { SimilarityContext, SimilarityTally } from './similarityLane.ts';
import { scoreLane } from './similarityLane.ts';

/**
 * Ranked similarity over the words of entries [e0, e1) of one block: a word is skipped when its
 * bit-count range misses the window; otherwise the bits its live lanes share with the query are
 * counted plane by plane, 16 at a time (Harley-Seal into 11 bit-sliced counters, so up to 1,024
 * scored bits), and the word dropped once no live lane can still reach `mMin`. A lane that reaches
 * it is scored exactly, filtered, counted, and kept when it ranks after the cursor (score desc, id
 * asc) among the best.
 * @param c - The block's context.
 * @param entries - The work entries.
 * @param e0 - The first entry.
 * @param e1 - One past the last entry.
 * @param res - Updated in place.
 */
export function similarityWords(
  c: SimilarityContext,
  entries: Float64Array,
  e0: number,
  e1: number,
  res: SimilarityTally,
): void {
  const { planes: p, poff: o, restr, base, zoneMin, zoneMax } = c;
  const { low, high, qBits, mMin, D } = c;
  const q = o.length;
  if (mMin > qBits) return;
  for (let e = e0; e < e1; e++) {
    const w0 = entries[4 * e + 1] as number;
    const w1 = entries[4 * e + 2] as number;
    const lastMask = (entries[4 * e + 3] as number) | 0;
    for (let w = w0; w < w1; w++) {
      if ((zoneMax[w] as number) < low || (zoneMin[w] as number) > high) {
        continue;
      }
      let alive = restr[base + w] as number;
      if (w === w1 - 1) alive &= lastMask;
      if (alive === 0) continue;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let s4 = 0;
      let s5 = 0;
      let s6 = 0;
      let s7 = 0;
      let s8 = 0;
      let s9 = 0;
      let s10 = 0;
      let j = 0;
      let dead = false;
      while (j + 16 <= q) {
        // Two planes into s0 with a carry-save adder; four carries into s1; then s2, s3.
        let x0 = p[(o[j] as number) + w] as number;
        let x1 = p[(o[j + 1] as number) + w] as number;
        let u = s0 ^ x0;
        let tA = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        x0 = p[(o[j + 2] as number) + w] as number;
        x1 = p[(o[j + 3] as number) + w] as number;
        u = s0 ^ x0;
        let tB = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        u = s1 ^ tA;
        let fA = (s1 & tA) | (u & tB);
        s1 = u ^ tB;
        x0 = p[(o[j + 4] as number) + w] as number;
        x1 = p[(o[j + 5] as number) + w] as number;
        u = s0 ^ x0;
        tA = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        x0 = p[(o[j + 6] as number) + w] as number;
        x1 = p[(o[j + 7] as number) + w] as number;
        u = s0 ^ x0;
        tB = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        u = s1 ^ tA;
        let fB = (s1 & tA) | (u & tB);
        s1 = u ^ tB;
        u = s2 ^ fA;
        const eA = (s2 & fA) | (u & fB);
        s2 = u ^ fB;
        x0 = p[(o[j + 8] as number) + w] as number;
        x1 = p[(o[j + 9] as number) + w] as number;
        u = s0 ^ x0;
        tA = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        x0 = p[(o[j + 10] as number) + w] as number;
        x1 = p[(o[j + 11] as number) + w] as number;
        u = s0 ^ x0;
        tB = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        u = s1 ^ tA;
        fA = (s1 & tA) | (u & tB);
        s1 = u ^ tB;
        x0 = p[(o[j + 12] as number) + w] as number;
        x1 = p[(o[j + 13] as number) + w] as number;
        u = s0 ^ x0;
        tA = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        x0 = p[(o[j + 14] as number) + w] as number;
        x1 = p[(o[j + 15] as number) + w] as number;
        u = s0 ^ x0;
        tB = (s0 & x0) | (u & x1);
        s0 = u ^ x1;
        u = s1 ^ tA;
        fB = (s1 & tA) | (u & tB);
        s1 = u ^ tB;
        u = s2 ^ fA;
        const eB = (s2 & fA) | (u & fB);
        s2 = u ^ fB;
        u = s3 ^ eA;
        let carry = (s3 & eA) | (u & eB);
        s3 = u ^ eB;
        // The weight-16 carry ripples up s4..s10.
        let t = s4 & carry;
        s4 ^= carry;
        carry = t;
        t = s5 & carry;
        s5 ^= carry;
        carry = t;
        t = s6 & carry;
        s6 ^= carry;
        carry = t;
        t = s7 & carry;
        s7 ^= carry;
        carry = t;
        t = s8 & carry;
        s8 ^= carry;
        carry = t;
        t = s9 & carry;
        s9 ^= carry;
        s10 ^= t;
        j += 16;
        // A lane stays alive while its count can still reach mMin: at least j − D.
        const K = j - D;
        if (
          K > 0 &&
          (atLeast(K, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10) & alive) ===
            0
        ) {
          dead = true;
          break;
        }
      }
      if (dead) continue;
      for (; j < q; j++) {
        let carry = p[(o[j] as number) + w] as number;
        let t = s0 & carry;
        s0 ^= carry;
        carry = t;
        t = s1 & carry;
        s1 ^= carry;
        carry = t;
        t = s2 & carry;
        s2 ^= carry;
        carry = t;
        t = s3 & carry;
        s3 ^= carry;
        carry = t;
        t = s4 & carry;
        s4 ^= carry;
        carry = t;
        t = s5 & carry;
        s5 ^= carry;
        carry = t;
        t = s6 & carry;
        s6 ^= carry;
        carry = t;
        t = s7 & carry;
        s7 ^= carry;
        carry = t;
        t = s8 & carry;
        s8 ^= carry;
        carry = t;
        t = s9 & carry;
        s9 ^= carry;
        s10 ^= t;
      }
      let m =
        atLeast(mMin, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10) & alive;
      while (m !== 0) {
        const lowest = m & -m;
        m ^= lowest;
        const i = 31 - Math.clz32(lowest);
        const shared = laneCount(
          i,
          s0,
          s1,
          s2,
          s3,
          s4,
          s5,
          s6,
          s7,
          s8,
          s9,
          s10,
        );
        scoreLane(c, res, (w << 5) | i, shared);
      }
    }
  }
}
