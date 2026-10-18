import { DatabaseSync } from 'node:sqlite';

import { splitTileKey, tileKey } from '../../chemistry/tile.ts';
import type { NormalizedSpec } from '../spec.ts';
import { setName } from '../spec.ts';

/** One set the index holds a bitmap for. */
export interface SetEntry {
  /** Its full name: `family` or `family:name`. */
  name: string;
  /** Its family. */
  family: string;
  /** Its name within the family, as the names SQL returned it; null for a family that is one set. */
  value: unknown;
}

/** What a load reads first, in one read transaction. */
export interface LoadPlan {
  /** The atom counts the tiles hold, ascending. */
  atomCounts: number[];
  /** `ocl_meta.seq`: the image holds every molecule with a seq up to it. */
  watermark: number;
  /** The sets at load. */
  sets: SetEntry[];
  /** The change log's last id at load, null without a change log. */
  changeId: number | null;
}

/**
 * Opens a read-only connection with the settings of the readers.
 * @param file - The database.
 * @returns The connection.
 */
export function openReader(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 30000');
  return db;
}

/**
 * Reads the plan of a load: one seek per atom count, the watermark, the set names, the change log
 * position.
 * @param file - The database.
 * @param spec - The application's specification.
 * @returns The plan.
 */
export function readPlan(file: string, spec: NormalizedSpec): LoadPlan {
  const db = openReader(file);
  try {
    db.exec('BEGIN');
    const atomCounts: number[] = [];
    const first = db.prepare(
      'SELECT id FROM ocl_tile WHERE id >= ? ORDER BY id LIMIT 1',
    );
    for (let probe = 0; ;) {
      const row = first.get(probe) as { id: number } | undefined;
      if (row === undefined) break;
      const { atoms } = splitTileKey(row.id);
      atomCounts.push(atoms);
      probe = tileKey(atoms + 1, 0, 0);
    }
    const seq = db
      .prepare("SELECT value FROM ocl_meta WHERE name = 'seq'")
      .get() as { value: number } | undefined;
    const sets = readSets(db, spec);
    const changeId =
      spec.changes === null ? null : readLastChange(db, spec.changes.last);
    db.exec('COMMIT');
    return { atomCounts, watermark: seq?.value ?? 0, sets, changeId };
  } finally {
    db.close();
  }
}

/**
 * The sets the specification names now.
 * @param db - A read connection.
 * @param spec - The specification.
 * @returns Every set, family by family.
 */
export function readSets(db: DatabaseSync, spec: NormalizedSpec): SetEntry[] {
  const sets: SetEntry[] = [];
  for (const { family, names } of spec.families) {
    if (names === null) {
      sets.push({ name: family, family, value: null });
      continue;
    }
    const statement = db.prepare(names);
    statement.setReturnArrays(true);
    for (const row of statement.all() as unknown as unknown[][]) {
      const value = row[0];
      const name = setName(family, value);
      if (!sets.some((set) => set.name === name)) {
        sets.push({ name, family, value });
      }
    }
  }
  return sets;
}

/**
 * The change log's last id.
 * @param db - A read connection.
 * @param sql - The specification's `changes.last`.
 * @returns It, 0 when none.
 */
export function readLastChange(db: DatabaseSync, sql: string): number {
  const statement = db.prepare(sql);
  statement.setReturnArrays(true);
  const row = statement.get() as unknown[] | undefined;
  return Number(row?.[0] ?? 0);
}
