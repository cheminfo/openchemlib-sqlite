import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { Signatures } from '../chemistry/stamp.ts';

import type { CountedSignatures, StoreMeta } from './schema.ts';

/** The fingerprints whose bits are counted, in the order their counts are kept. */
export const COUNTED_FINGERPRINTS = ['fragFp', 'screen', 'functions'] as const;

/** A fingerprint whose bits are counted. */
export type CountedFingerprint = (typeof COUNTED_FINGERPRINTS)[number];

/** Bits per fingerprint. */
export const FINGERPRINT_BITS = 512;

/** The counts kept: FragFp, then the screen, then the function bits, 512 each. */
export const COUNTED_BITS = 3 * FINGERPRINT_BITS;

/** Where each fingerprint's counts start. */
export const COUNTS_AT: Readonly<Record<CountedFingerprint, number>> = {
  fragFp: 0,
  screen: FINGERPRINT_BITS,
  functions: 2 * FINGERPRINT_BITS,
};

/** Which fingerprints' counts a write keeps: those counted under this build's keys. */
export type Counting = Record<CountedFingerprint, boolean>;

/**
 * How many of the stored molecules hold each key, per fingerprint, in key order: entry k counts
 * the molecules holding key k of `getFragFpKeys()`, `getScreenKeys()` or
 * `getFunctionKeyFragments()`. The function rows count the planes 1024-1535 the tiles store.
 */
export interface BitCounts {
  /** The molecules the store holds: a share is a count divided by it. */
  molecules: number;
  /** Per FragFp key; null while not counted under this build's keys. */
  fragFp: Float64Array | null;
  /** Per screen key; null while not counted under this build's keys. */
  screen: Float64Array | null;
  /** Per function key; null while not counted under this build's keys. */
  functions: Float64Array | null;
}

/**
 * The statements creating a counts table, every count at zero.
 * @param table - Its name.
 * @returns SQL statements.
 */
export function countsTableSql(table: string): string[] {
  return [
    `CREATE TABLE ${table} (bit INTEGER PRIMARY KEY, population INTEGER NOT NULL)`,
    `WITH RECURSIVE n(bit) AS (SELECT 0 UNION ALL SELECT bit + 1 FROM n WHERE bit < ${COUNTED_BITS - 1})
      INSERT INTO ${table} (bit, population) SELECT bit, 0 FROM n`,
  ];
}

/**
 * Which fingerprints a file counts under this build's keys.
 * @param counted - What the file's counts were counted under.
 * @param signatures - This build's signatures.
 * @returns The fingerprints whose counts are this build's.
 */
export function countingOf(
  counted: CountedSignatures,
  signatures: Signatures,
): Counting {
  return {
    fragFp: counted.fragFp === signatures.fragFp,
    screen: counted.screen === signatures.screen,
    functions: counted.functions === signatures.functions,
  };
}

/**
 * The statement adding to one count.
 * @param db - The connection.
 * @param table - The counts table.
 * @returns It, taking the amount then the bit.
 */
export function prepareAddCount(
  db: DatabaseSync,
  table = 'ocl_bits',
): StatementSync {
  return db.prepare(
    `UPDATE ${table} SET population = population + ? WHERE bit = ?`,
  );
}

/**
 * Adds a change to the counts of the fingerprints it keeps.
 * @param add - The statement of {@link prepareAddCount}.
 * @param delta - What each count changes by, {@link COUNTED_BITS} of them.
 * @param counting - The fingerprints whose counts change.
 */
export function addCounts(
  add: StatementSync,
  delta: Float64Array,
  counting: Counting,
): void {
  for (const fingerprint of COUNTED_FINGERPRINTS) {
    if (!counting[fingerprint]) continue;
    const at = COUNTS_AT[fingerprint];
    for (let bit = at; bit < at + FINGERPRINT_BITS; bit++) {
      const change = delta[bit] as number;
      if (change !== 0) add.run(change, bit);
    }
  }
}

/**
 * Reads the counts of the fingerprints counted under this build's keys.
 * @param db - The connection.
 * @param meta - The file's `ocl_meta`.
 * @param signatures - This build's signatures.
 * @returns The counts.
 */
export function readBitCounts(
  db: DatabaseSync,
  meta: StoreMeta,
  signatures: Signatures,
): BitCounts {
  const counting = countingOf(meta.counted, signatures);
  const all = new Float64Array(COUNTED_BITS);
  if (Object.values(counting).some(Boolean)) {
    for (const row of db
      .prepare('SELECT bit, population FROM ocl_bits')
      .all() as Array<{ bit: number; population: number }>) {
      all[row.bit] = row.population;
    }
  }
  const part = (fingerprint: CountedFingerprint) =>
    counting[fingerprint]
      ? all.slice(
          COUNTS_AT[fingerprint],
          COUNTS_AT[fingerprint] + FINGERPRINT_BITS,
        )
      : null;
  return {
    molecules: meta.count,
    fragFp: part('fragFp'),
    screen: part('screen'),
    functions: part('functions'),
  };
}
