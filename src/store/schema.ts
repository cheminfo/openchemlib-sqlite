import type { DatabaseSync } from 'node:sqlite';

import type { Signatures, StampParts } from '../chemistry/stamp.ts';
import { FORMAT } from '../chemistry/stamp.ts';

import { countsTableSql } from './bitCounts.ts';

/** The index of the idCode hashes, alone so that `rebuild()` can add it to a file lacking it. */
export const ID_CODE_HASH_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS ocl_molecule_idcode ON ocl_molecule (idCodeHash)';

/**
 * The library's tables. They are created, validated and written only by the library, from the
 * idCode alone; the application keys its own tables by the same id.
 */
export const LIBRARY_SQL: readonly string[] = [
  `CREATE TABLE ocl_molecule (
    id INTEGER PRIMARY KEY,
    noStereoHash INTEGER NOT NULL,
    tautomerHash INTEGER NOT NULL,
    idCode TEXT NOT NULL,
    idCodeHash INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX ocl_molecule_nostereo ON ocl_molecule (noStereoHash)',
  'CREATE INDEX ocl_molecule_tautomer ON ocl_molecule (tautomerHash)',
  ID_CODE_HASH_INDEX_SQL,
  'CREATE TABLE ocl_tile (id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
  'CREATE TABLE ocl_meta (name TEXT PRIMARY KEY, value ANY NOT NULL) WITHOUT ROWID',
  ...countsTableSql('ocl_bits'),
];

/** The signatures of what a file stores, as `ocl_meta` records them; `''` for a part it lacks. */
export type StoredSignatures = StampParts;

/** The fingerprints whose bits are counted. */
export type CountedSignatures = Pick<
  Signatures,
  'fragFp' | 'screen' | 'functions'
>;

/** What `ocl_meta` holds. */
export interface StoreMeta {
  /** The file format, {@link FORMAT}. */
  format: string;
  /** The stamp the file was written under. */
  stamp: string;
  /** What its molecules and tiles were computed under; null for a file written before. */
  signatures: StoredSignatures | null;
  /** What each fingerprint's bit counts were counted under, `''` for one not counted. */
  counted: CountedSignatures;
  /** Raised by each rebuild: a store opened before it writes again only under the same build. */
  generation: number;
  /** The rebuild under way, `''` when none: no molecule is written meanwhile. */
  rebuild: string;
  /** The last seq issued. */
  seq: number;
  /** How many molecules the file holds. */
  count: number;
  /** How many distinct no-stereo hashes they carry: the compounds, stereochemistry aside. */
  distinctNoStereo: number;
  /** How many distinct tautomer hashes they carry: the tautomer families. */
  distinctTautomer: number;
}

/** How many distinct identity hashes the stored molecules carry. */
export interface DistinctHashes {
  /** Distinct no-stereo hashes: the compounds, stereochemistry aside. */
  noStereo: number;
  /** Distinct tautomer hashes: the tautomer families. */
  tautomer: number;
}

/**
 * Whether a table has a column.
 * @param db - The connection.
 * @param table - The table.
 * @param column - The column.
 * @returns True when it is there.
 */
export function hasColumn(
  db: DatabaseSync,
  table: string,
  column: string,
): boolean {
  return (
    db
      .prepare('SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?')
      .get(table, column) !== undefined
  );
}

/**
 * Whether the database holds a table.
 * @param db - The connection.
 * @param name - The table.
 * @returns True when it is there.
 */
export function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

/**
 * Whether the database holds the library's tables.
 * @param db - The connection.
 * @returns True once {@link createStore} has run on it.
 */
export function hasStore(db: DatabaseSync): boolean {
  return hasTable(db, 'ocl_meta');
}

/**
 * Creates the library's tables in one transaction, the bit counts at zero and counted under this
 * build's keys.
 * @param db - The connection, outside any transaction.
 * @param stamp - The stamp of this build.
 * @param signatures - The signatures of this build.
 */
export function createStore(
  db: DatabaseSync,
  stamp: string,
  signatures: Signatures,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const sql of LIBRARY_SQL) db.exec(sql);
    const insert = db.prepare(
      'INSERT INTO ocl_meta (name, value) VALUES (?, ?)',
    );
    insert.run('format', FORMAT);
    insert.run('stamp', stamp);
    insert.run('seq', 0);
    insert.run('count', 0);
    insert.run('distinctNoStereo', 0);
    insert.run('distinctTautomer', 0);
    insert.run('generation', 0);
    for (const [name, value] of signatureRows(signatures)) {
      insert.run(name, value);
    }
    for (const [name, value] of countedRows(signatures)) {
      insert.run(name, value);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Reads `ocl_meta`.
 * @param db - The connection.
 * @returns Its values.
 */
export function readMeta(db: DatabaseSync): StoreMeta {
  const rows = db.prepare('SELECT name, value FROM ocl_meta').all() as Array<{
    name: string;
    value: unknown;
  }>;
  const values = new Map(rows.map((row) => [row.name, row.value]));
  const identity = text(values.get('signature.identity'));
  return {
    format: text(values.get('format')),
    stamp: text(values.get('stamp')),
    signatures:
      identity === ''
        ? null
        : {
            identity,
            fragFp: text(values.get('signature.fragFp')),
            screen: text(values.get('signature.screen')),
            functions: text(values.get('signature.functions')),
            idCodeHash: text(values.get('signature.idCodeHash')),
          },
    counted: {
      fragFp: text(values.get('counted.fragFp')),
      screen: text(values.get('counted.screen')),
      functions: text(values.get('counted.functions')),
    },
    generation: Number(values.get('generation') ?? 0),
    rebuild: text(values.get('rebuild')),
    seq: Number(values.get('seq') ?? 0),
    count: Number(values.get('count') ?? 0),
    distinctNoStereo: Number(values.get('distinctNoStereo') ?? 0),
    distinctTautomer: Number(values.get('distinctTautomer') ?? 0),
  };
}

/**
 * The `ocl_meta` rows recording what the molecules and the tiles were computed under.
 * @param signatures - The signatures.
 * @returns Name and value pairs.
 */
export function signatureRows(
  signatures: StoredSignatures,
): Array<[string, string]> {
  return [
    ['signature.identity', signatures.identity],
    ['signature.fragFp', signatures.fragFp],
    ['signature.screen', signatures.screen],
    ['signature.functions', signatures.functions],
    ['signature.idCodeHash', signatures.idCodeHash],
  ];
}

/**
 * The `ocl_meta` rows recording what the bit counts were counted under.
 * @param signatures - The signatures.
 * @returns Name and value pairs.
 */
export function countedRows(
  signatures: CountedSignatures,
): Array<[string, string]> {
  return [
    ['counted.fragFp', signatures.fragFp],
    ['counted.screen', signatures.screen],
    ['counted.functions', signatures.functions],
  ];
}

/**
 * A meta value as text, `''` when the row is missing. `value` has numeric affinity, so a signature
 * made of digits alone comes back as a number.
 * @param value - The value read.
 * @returns It as text.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : '';
}
