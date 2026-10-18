/**
 * The lanes of a word whose count, held bit-sliced in s0 (weight 1) to s10 (weight 1,024), is at
 * least k: one compare per bit, from the top.
 * @param k - The bound, 0 to 2,047.
 * @param s0 - Counter bit 0.
 * @param s1 - Counter bit 1.
 * @param s2 - Counter bit 2.
 * @param s3 - Counter bit 3.
 * @param s4 - Counter bit 4.
 * @param s5 - Counter bit 5.
 * @param s6 - Counter bit 6.
 * @param s7 - Counter bit 7.
 * @param s8 - Counter bit 8.
 * @param s9 - Counter bit 9.
 * @param s10 - Counter bit 10.
 * @returns The lanes, as a 32-bit mask.
 */
export function atLeast(
  k: number,
  s0: number,
  s1: number,
  s2: number,
  s3: number,
  s4: number,
  s5: number,
  s6: number,
  s7: number,
  s8: number,
  s9: number,
  s10: number,
): number {
  let gt = 0;
  let eq = -1;
  let a = -((k >>> 10) & 1);
  gt |= eq & s10 & ~a;
  eq &= ~(s10 ^ a);
  a = -((k >>> 9) & 1);
  gt |= eq & s9 & ~a;
  eq &= ~(s9 ^ a);
  a = -((k >>> 8) & 1);
  gt |= eq & s8 & ~a;
  eq &= ~(s8 ^ a);
  a = -((k >>> 7) & 1);
  gt |= eq & s7 & ~a;
  eq &= ~(s7 ^ a);
  a = -((k >>> 6) & 1);
  gt |= eq & s6 & ~a;
  eq &= ~(s6 ^ a);
  a = -((k >>> 5) & 1);
  gt |= eq & s5 & ~a;
  eq &= ~(s5 ^ a);
  a = -((k >>> 4) & 1);
  gt |= eq & s4 & ~a;
  eq &= ~(s4 ^ a);
  a = -((k >>> 3) & 1);
  gt |= eq & s3 & ~a;
  eq &= ~(s3 ^ a);
  a = -((k >>> 2) & 1);
  gt |= eq & s2 & ~a;
  eq &= ~(s2 ^ a);
  a = -((k >>> 1) & 1);
  gt |= eq & s1 & ~a;
  eq &= ~(s1 ^ a);
  a = -(k & 1);
  gt |= eq & s0 & ~a;
  eq &= ~(s0 ^ a);
  return gt | eq;
}

/**
 * One lane's count, read back from the 11 bit-sliced counters.
 * @param i - The lane.
 * @param s0 - Counter bit 0.
 * @param s1 - Counter bit 1.
 * @param s2 - Counter bit 2.
 * @param s3 - Counter bit 3.
 * @param s4 - Counter bit 4.
 * @param s5 - Counter bit 5.
 * @param s6 - Counter bit 6.
 * @param s7 - Counter bit 7.
 * @param s8 - Counter bit 8.
 * @param s9 - Counter bit 9.
 * @param s10 - Counter bit 10.
 * @returns The count.
 */
export function laneCount(
  i: number,
  s0: number,
  s1: number,
  s2: number,
  s3: number,
  s4: number,
  s5: number,
  s6: number,
  s7: number,
  s8: number,
  s9: number,
  s10: number,
): number {
  return (
    ((s0 >>> i) & 1) |
    (((s1 >>> i) & 1) << 1) |
    (((s2 >>> i) & 1) << 2) |
    (((s3 >>> i) & 1) << 3) |
    (((s4 >>> i) & 1) << 4) |
    (((s5 >>> i) & 1) << 5) |
    (((s6 >>> i) & 1) << 6) |
    (((s7 >>> i) & 1) << 7) |
    (((s8 >>> i) & 1) << 8) |
    (((s9 >>> i) & 1) << 9) |
    (((s10 >>> i) & 1) << 10)
  );
}

/**
 * Inserts a row among the best kept (higher score first, then lower id).
 * @param topId - The kept ids; its length is the most kept.
 * @param topScore - Their scores.
 * @param kept - How many are kept.
 * @param id - The row's id.
 * @param score - Its score.
 * @returns How many are kept now.
 */
export function keepTop(
  topId: Float64Array,
  topScore: Float64Array,
  kept: number,
  id: number,
  score: number,
): number {
  const limit = topId.length;
  let size = kept;
  if (size === limit) {
    const lastScore = topScore[limit - 1] as number;
    const lastId = topId[limit - 1] as number;
    if (!(score > lastScore || (score === lastScore && id < lastId))) {
      return kept;
    }
    size--;
  }
  let at = size;
  while (at > 0) {
    const before = topScore[at - 1] as number;
    if (!(
      before < score ||
      (before === score && (topId[at - 1] as number) > id)
    )) {
      break;
    }
    topId[at] = topId[at - 1] as number;
    topScore[at] = before;
    at--;
  }
  topId[at] = id;
  topScore[at] = score;
  return size + 1;
}
