/**
 * Candidate keys in the clustered order, `(mw, entry_id)`, and the merge of
 * streams already sorted in it.
 */

/** A candidate's place in the clustered order. */
export interface Key {
  mw: number;
  entryId: number;
}

/**
 * Merge sorted streams of keys into one sorted stream. There are as many
 * streams as folds, plus one, so the smallest head is found by looking.
 * @param streams - The streams, each sorted.
 * @yields {Key} Every key, in order.
 */
export function* mergeInOrder(streams: Array<Iterator<Key>>): Generator<Key> {
  const heads: Array<Key | undefined> = streams.map((stream) => {
    const next = stream.next();
    return next.done ? undefined : next.value;
  });
  for (;;) {
    let best = -1;
    for (let index = 0; index < heads.length; index++) {
      const head = heads[index];
      if (head === undefined) continue;
      const current = heads[best];
      if (current === undefined || compareKeys(head, current) < 0) best = index;
    }
    const smallest = heads[best];
    if (smallest === undefined) return;
    yield smallest;
    const next = (streams[best] as Iterator<Key>).next();
    heads[best] = next.done ? undefined : next.value;
  }
}

/**
 * Order keys as the clustered index does.
 * @param a - One key.
 * @param b - The other.
 * @returns Negative when `a` comes first.
 */
export function compareKeys(a: Key, b: Key): number {
  return a.mw - b.mw || a.entryId - b.entryId;
}

/**
 * The first position of a sorted array holding a value at least as large.
 * @param values - The array, ascending.
 * @param value - The value.
 * @returns The position, or the length when every value is smaller.
 */
export function lowerBound(values: Uint32Array, value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
