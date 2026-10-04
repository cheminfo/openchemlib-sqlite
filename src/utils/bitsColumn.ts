import { sameFingerprint } from '../planes/watermarkSchema.ts';
import type { SQLiteDatabase } from '../types.ts';

import { BITS_COLUMN, COLUMNS_TABLE, hasColumnsTable } from './indexColumns.ts';

/** The trigger that forgets a bit count the fingerprint changed under. */
export const STALE_BITS_TRIGGER = 'ocl_ss_bits_stale';

/**
 * Whether `ocl_ss_index` stores each entry's bit count.
 *
 * Where it does, a NULL count still means "not known" rather than anything a
 * search may skip: an entry indexed before the column existed and not filled
 * since, or written by the caller's own SQL, which does not set it.
 * @param db - The database to read.
 * @returns True when the column exists and is recorded.
 */
export function carriesBits(db: SQLiteDatabase): boolean {
  if (!hasColumnsTable(db)) return false;
  return (
    db
      .prepare(`SELECT 1 FROM ${COLUMNS_TABLE} WHERE name = ?`)
      .get(BITS_COLUMN) !== undefined
  );
}

/**
 * SQL creating the trigger that forgets an entry's bit count when its
 * fingerprint is changed in place without it.
 *
 * The library never updates a fingerprint in place — it inserts the row again
 * with its count — but a caller writing `ocl_ss_index` itself may, and a count
 * left over from the old fingerprint would make a similarity search skip an
 * entry that reaches the threshold. Set back to NULL, the entry is computed
 * like any entry whose count is not known. An update that also changes the
 * count is trusted.
 * @returns SQL ready for db.exec().
 */
export function buildStaleBitsTriggerSql(): string {
  const words: string[] = [];
  for (let word = 0; word < 8; word++) words.push(`ss_index${word}`);
  return `CREATE TRIGGER IF NOT EXISTS ${STALE_BITS_TRIGGER}
AFTER UPDATE OF ${words.join(', ')} ON ocl_ss_index
WHEN NEW.${BITS_COLUMN} IS OLD.${BITS_COLUMN}
  AND NOT (${sameFingerprint('OLD', 'NEW')})
BEGIN
  UPDATE ocl_ss_index SET ${BITS_COLUMN} = NULL WHERE entry_id = NEW.entry_id;
END;`;
}
