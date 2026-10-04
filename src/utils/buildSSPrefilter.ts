import { packSSIndex } from './packSSIndex.ts';

/** One word of the prefilter: a condition and its two parameters. */
export interface PrefilterTerm {
  /** `(s.ss_indexN & ?) = ?`. */
  sql: string;
  /** The query's word, twice. */
  params: bigint[];
}

/**
 * Build SQL AND conditions that pre-filter rows whose ss_index bits are a
 * superset of the query bits — i.e. (stored & query) = query for each 64-bit
 * word the query sets bits in. The s. alias refers to the ocl_ss_index table.
 *
 * A word the query leaves at zero is not tested: `(word & 0) = 0` holds for
 * every row and would only cost a column read each. A query setting no bit at
 * all is therefore filtered by nothing, which `1` says.
 * @param queryIndex - OCL fingerprint of the query molecule.
 * @param words - The words to test, as columns 0–7, in the order to test them;
 *   by default every non-zero word, those setting most bits first.
 * @returns SQL fragment, bound BigInt parameters, and the same split by word.
 */
export function buildSSPrefilter(
  queryIndex: ArrayLike<number>,
  words?: readonly number[],
): { sql: string; params: bigint[]; terms: PrefilterTerm[] } {
  const packed = packSSIndex(Array.from(queryIndex));
  const order = words ?? defaultOrder(packed);
  const terms: PrefilterTerm[] = [];
  for (const word of order) {
    const value = packed[word] ?? 0n;
    if (value === 0n) continue;
    terms.push({ sql: `(s.ss_index${word} & ?) = ?`, params: [value, value] });
  }
  if (terms.length === 0) return { sql: '1', params: [], terms };
  return {
    sql: terms.map((term) => term.sql).join(' AND '),
    params: terms.flatMap((term) => term.params),
    terms,
  };
}

/**
 * The non-zero words of a query, those setting most bits first: the likeliest
 * to reject a row at once.
 * @param packed - The query's eight 64-bit words.
 * @returns The words, as columns 0–7.
 */
export function defaultOrder(packed: readonly bigint[]): number[] {
  const words: Array<{ word: number; bits: number }> = [];
  for (let word = 0; word < packed.length; word++) {
    const value = packed[word] ?? 0n;
    if (value !== 0n) words.push({ word, bits: bitCount(value) });
  }
  return words
    .toSorted((a, b) => b.bits - a.bits || a.word - b.word)
    .map((entry) => entry.word);
}

/**
 * How many bits a 64-bit word sets.
 * @param word - The word, as SQLite stores it.
 * @returns Its population count.
 */
function bitCount(word: bigint): number {
  let value = BigInt.asUintN(64, word);
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count++;
  }
  return count;
}
