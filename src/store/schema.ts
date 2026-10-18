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
 * Gives a file written before the library kept signatures the signatures of this build, when it
 * carries the stamp this build gives such a file: those of its molecules and tiles, with bit
 * counts at zero that count nothing yet, and no idCode hashes, which `rebuild()` adds. Done once,
 * in one write transaction.
 * @param db - The connection, outside any transaction.
 * @param stamps - The stamp such a file takes, and the stamp it carries.
 * @param stamps.stamp - The stamp of this build's molecules and tiles without idCode hashes.
 * @param stamps.legacy - The stamp of a file written before signatures.
 * @param signatures - This build's signatures.
 * @returns True when the file was upgraded.
 */
export function ensureSignatures(
  db: DatabaseSync,
  stamps: { stamp: string; legacy: string },
  signatures: Signatures,
): boolean {
  const has = db.prepare(
    "SELECT 1 AS found FROM ocl_meta WHERE name = 'signature.identity'",
  );
  if (has.get() !== undefined) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another connection may have upgraded it while this one waited for the lock.
    if (has.get() !== undefined || readMeta(db).stamp !== stamps.legacy) {
      db.exec('COMMIT');
      return false;
    }
    const insert = db.prepare(
      'INSERT OR REPLACE INTO ocl_meta (name, value) VALUES (?, ?)',
    );
    insert.run('stamp', stamps.stamp);
    insert.run('generation', 0);
    for (const [name, value] of signatureRows({
      ...signatures,
      idCodeHash: '',
    })) {
      insert.run(name, value);
    }
    if (!hasTable(db, 'ocl_bits')) {
      for (const sql of countsTableSql('ocl_bits')) db.exec(sql);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Adds the two distinct-hash counters to a file written before the library kept them: each is
 * counted once, walking its hash index, inside one write transaction so no commit lands between
 * the count and the row. Every commit and removal keeps them exact afterwards.
 * @param db - The connection, outside any transaction.
 * @returns True when they were added, false when the file had them.
 */
export function ensureDistinctCounts(db: DatabaseSync): boolean {
  const has = db.prepare(
    "SELECT 1 AS found FROM ocl_meta WHERE name = 'distinctNoStereo'",
  );
  if (has.get() !== undefined) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another connection may have added them while this one waited for the lock.
    if (has.get() !== undefined) {
      db.exec('COMMIT');
      return false;
    }
    // One statement per column: each walks its covering index, where counting both at once
    // would scan the table into two temporary B-trees.
    const distinct = (column: string) =>
      (
        db
          .prepare(`SELECT count(DISTINCT ${column}) AS n FROM ocl_molecule`)
          .get() as { n: number }
      ).n;
    const insert = db.prepare(
      'INSERT INTO ocl_meta (name, value) VALUES (?, ?)',
    );
    insert.run('distinctNoStereo', distinct('noStereoHash'));
    insert.run('distinctTautomer', distinct('tautomerHash'));
    db.exec('COMMIT');
    return true;
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Refuses a file this build cannot search or write: another format, molecules computed under
 * another identity, or fingerprints computed under other keys. Searching it would screen stored
 * fingerprints against query fingerprints computed differently, and miss matches without any
 * error. Each refusal says what to do.
 * @param meta - The file's `ocl_meta`.
 * @param stamp - The stamp of this build.
 * @param signatures - The signatures of this build.
 */
export function validateMeta(
  meta: StoreMeta,
  stamp: string,
  signatures: Signatures,
): void {
  if (meta.format !== FORMAT) {
    throw new Error(
      `ocl_meta.format is "${meta.format}", this build reads "${FORMAT}": the file must be migrated`,
    );
  }
  const stored = meta.signatures;
  if (stored === null) {
    throw new Error(
      `the file was written under stamp ${meta.stamp} by an earlier build, which this one cannot read: commit its idCodes into a new file`,
    );
  }
  if (stored.identity !== signatures.identity) {
    throw new Error(
      'the file holds molecules canonized or hashed differently from this build: commit its idCodes into a new file',
    );
  }
  const stale = staleTiles(stored, signatures);
  if (stale.length > 0) {
    throw new Error(
      `the ${stale.join(' and ')} bits of the file were computed under other keys: run MoleculeStore.rebuild() with this build, while the build that wrote it keeps serving`,
    );
  }
  if (stored.idCodeHash !== signatures.idCodeHash) {
    throw new Error(
      'the file holds no idCode hashes, or hashes computed otherwise: run MoleculeStore.rebuild() with this build, while the build that wrote it keeps serving',
    );
  }
  if (meta.stamp !== stamp) {
    throw new Error(
      `the file was written under stamp ${meta.stamp}, this build computes ${stamp}: its fingerprints and hashes must be rebuilt`,
    );
  }
}

/**
 * The fingerprints a file's tiles hold under other keys than this build's.
 * @param stored - What the file was computed under.
 * @param signatures - This build's signatures.
 * @returns `fragFp`, `screen`, both or none.
 */
export function staleTiles(
  stored: StoredSignatures,
  signatures: Signatures,
): Array<'fragFp' | 'screen'> {
  const stale: Array<'fragFp' | 'screen'> = [];
  if (stored.fragFp !== signatures.fragFp) stale.push('fragFp');
  if (stored.screen !== signatures.screen) stale.push('screen');
  return stale;
}

/**
 * Refuses a file an index cannot search with this build, by its stamp alone.
 * @param meta - The file's `ocl_meta`.
 * @param stamp - The stamp of this build.
 */
export function validateStamp(meta: StoreMeta, stamp: string): void {
  if (meta.format !== FORMAT) {
    throw new Error(
      `ocl_meta.format is "${meta.format}", this build reads "${FORMAT}": the file must be migrated`,
    );
  }
  if (meta.signatures === null) {
    throw new Error(
      'the file was written before the library kept signatures: open it once with MoleculeStore, which upgrades it',
    );
  }
  if (meta.stamp !== stamp) {
    throw new Error(
      `the file was written under stamp ${meta.stamp}, this build computes ${stamp}: MoleculeStore.rebuild() must bring it to this build first`,
    );
  }
}
