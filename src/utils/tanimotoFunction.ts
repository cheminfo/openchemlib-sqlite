import type { SQLiteDatabase } from '../types.ts';

import { bitCount } from './fingerprintBits.ts';

/** The SQL function a similarity scan computes each entry's coefficient with. */
const TANIMOTO_FUNCTION = 'ocl_ss_tanimoto';

/** The 32-bit words of a fingerprint: two in each of the eight columns. */
const WORDS = 16;

/** The fingerprints of the scans running now, by the key their SQL binds. */
const queries = new Map<number, ArrayLike<number>>();

let nextKey = 1;

const installed = new WeakSet<SQLiteDatabase>();

/**
 * Register the Tanimoto function on a connection, once.
 *
 * A similarity scan reads every entry, and handing each row to JavaScript —
 * ten columns, eight of them BigInts, unpacked into a fresh array — is most of
 * what it costs. Computed inside the step instead, with the threshold in the
 * WHERE clause, only the entries that reach it ever leave SQLite.
 *
 * The coefficient is the one `SSSearcherWithIndex.getSimilarityTanimoto()`
 * returns: the bits both fingerprints set over the bits either sets.
 * @param db - The connection the scans run on.
 * @returns Whether the driver could take it; without it, the caller computes
 *   the coefficient itself.
 */
export function installTanimoto(db: SQLiteDatabase): boolean {
  if (installed.has(db)) return true;
  if (typeof db.function !== 'function') return false;
  db.function(
    TANIMOTO_FUNCTION,
    { deterministic: true, varargs: true },
    (key, ...words) => tanimoto(queries.get(Number(key)), words),
  );
  installed.add(db);
  return true;
}

/**
 * The SQL computing an entry's coefficient against the query bound under one
 * anonymous parameter: the key {@link withTanimotoQuery} hands out.
 *
 * Each 64-bit column is split into its two 32-bit words in SQL, so the
 * function receives plain numbers rather than BigInts.
 * @param alias - The alias of the fingerprint table, e.g. `s`.
 * @returns The SQL expression.
 */
export function tanimotoSql(alias: string): string {
  const words: string[] = [];
  for (let column = 0; column < WORDS / 2; column++) {
    const value = `${alias}.ss_index${column}`;
    words.push(`(${value} & 4294967295)`, `((${value} >> 32) & 4294967295)`);
  }
  return `${TANIMOTO_FUNCTION}(?, ${words.join(', ')})`;
}

/**
 * Make a query's fingerprint available to the function for the length of a
 * scan, under a key the scan's SQL binds.
 * @param fingerprint - The query's sixteen 32-bit words.
 * @param scan - Runs the scan, given the key.
 * @returns What the scan returned.
 */
export function withTanimotoQuery<T>(
  fingerprint: ArrayLike<number>,
  scan: (key: number) => T,
): T {
  const key = nextKey++;
  queries.set(key, fingerprint);
  try {
    return scan(key);
  } finally {
    queries.delete(key);
  }
}

/**
 * The bits both fingerprints set over the bits either sets.
 * @param query - The query's sixteen words.
 * @param words - The entry's sixteen words.
 * @returns The coefficient; NaN when neither sets a bit, as the library's own
 *   division gives, which no threshold accepts.
 */
function tanimoto(
  query: ArrayLike<number> | undefined,
  words: unknown[],
): number {
  if (query === undefined) return 0;
  let shared = 0;
  let either = 0;
  for (let word = 0; word < WORDS; word++) {
    const left = query[word] as number;
    const right = words[word] as number;
    shared += bitCount(left & right);
    either += bitCount(left | right);
  }
  return shared / either;
}
