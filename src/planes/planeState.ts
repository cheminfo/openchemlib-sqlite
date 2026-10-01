import type { SQLiteDatabase } from '../types.ts';

import { PLANE_BITS } from './planeLayout.ts';
import { BITSTAT_TABLE, SLOT_TABLE } from './planeSchema.ts';

/**
 * Settle which bits get planes, from the first chunk's populations.
 * @param db - The database to record the decision in.
 * @param populations - How many of the chunk's entries set each bit.
 * @param total - Entries in the chunk.
 * @param maxRatio - The share above which a bit gets no plane.
 * @returns The bits that will be stored.
 */
export function decideStoredBits(
  db: SQLiteDatabase,
  populations: ReadonlyMap<number, number>,
  total: number,
  maxRatio: number,
): Set<number> {
  const stored = new Set<number>();
  const write = db.prepare(
    `INSERT OR REPLACE INTO ${BITSTAT_TABLE} (bit, population, stored)
     VALUES (?, 0, ?)`,
  );
  for (let bit = 0; bit < PLANE_BITS; bit++) {
    const keep = (populations.get(bit) ?? 0) <= maxRatio * total;
    if (keep) stored.add(bit);
    write.run(bit, keep ? 1 : 0);
  }
  return stored;
}

/**
 * The bits the index already keeps planes for, or null when nothing is settled.
 * @param db - The database to read.
 * @returns The stored bits, or null before the first fold.
 */
export function storedBitsOf(db: SQLiteDatabase): Set<number> | null {
  const rows = db
    .prepare(`SELECT bit FROM ${BITSTAT_TABLE} WHERE stored = 1`)
    .all() as Array<Record<string, unknown>>;
  if (countOf(db, BITSTAT_TABLE) === 0) return null;
  return new Set(rows.map((row) => Number(row.bit)));
}

/**
 * The first unused slot.
 * @param db - The database to read.
 * @returns One past the highest slot in use, or 0.
 */
export function nextSlotOf(db: SQLiteDatabase): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(slot), -1) AS last FROM ${SLOT_TABLE}`)
    .get() as Record<string, unknown> | undefined;
  return Number(row?.last ?? -1) + 1;
}

/**
 * Count a table's rows.
 * @param db - The database to read.
 * @param table - The table to count.
 * @returns The row count.
 */
export function countOf(db: SQLiteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
    Record<string, unknown> | undefined;
  return Number(row?.n ?? 0);
}
