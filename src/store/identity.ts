import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { NO_HASH } from 'openchemlib-search-wasm';

import type { GroupOptions } from './storeOptions.ts';

/** The identity of a stored molecule. */
export interface MoleculeKeys {
  /** Its canonical idCode. */
  idCode: string;
  /** The hash of its canonical no-stereo idCode. */
  noStereoHash: bigint;
  /** The hash of its no-stereo generic tautomer; its no-stereo hash when truncated. */
  tautomerHash: bigint;
  /** The hash of its canonical idCode: OCL's StrongHasher, `strongHash(idCode)`. */
  idCodeHash: bigint;
}

/**
 * Which identity a hash lookup reads: the exact structure (`idCode`), the compound whatever its
 * stereochemistry (`noStereo`), or whatever its stereochemistry and tautomer (`tautomer`).
 */
export type HashKind = 'idCode' | 'noStereo' | 'tautomer';

/** The column each hash kind is stored in. */
const HASH_COLUMNS: Readonly<Record<HashKind, string>> = {
  idCode: 'idCodeHash',
  noStereo: 'noStereoHash',
  tautomer: 'tautomerHash',
};

/** The read statements of the identity lookups, prepared once per connection. */
export interface IdentityStatements {
  keys: StatementSync;
  /** Per hash kind: the ids holding a hash. */
  byHash: Record<HashKind, StatementSync>;
  /** Per hash kind: a page of the ids holding a hash, after an id. */
  hashAfter: Record<HashKind, StatementSync>;
  idCodes: StatementSync;
}

/**
 * Prepares the identity statements.
 * @param db - The connection.
 * @returns The statements.
 */
export function prepareIdentityStatements(
  db: DatabaseSync,
): IdentityStatements {
  const keys = db.prepare(
    'SELECT id, noStereoHash, tautomerHash, idCode, idCodeHash FROM ocl_molecule WHERE id IN (SELECT value FROM json_each(?))',
  );
  keys.setReadBigInts(true);
  const perKind = (sql: (column: string) => string) => {
    const out = {} as Record<HashKind, StatementSync>;
    for (const [kind, column] of Object.entries(HASH_COLUMNS)) {
      out[kind as HashKind] = db.prepare(sql(column));
    }
    return out;
  };
  return {
    keys,
    byHash: perKind(
      (column) => `SELECT id FROM ocl_molecule WHERE ${column} = ? ORDER BY id`,
    ),
    hashAfter: perKind(
      (column) =>
        `SELECT id FROM ocl_molecule WHERE ${column} = ? AND id > ? ORDER BY id LIMIT ?`,
    ),
    idCodes: db.prepare(
      'SELECT id, idCode FROM ocl_molecule WHERE noStereoHash = ?',
    ),
  };
}

/**
 * The identity of stored molecules.
 * @param statements - The identity statements.
 * @param ids - The ids.
 * @returns The keys of the ids the store holds.
 */
export function readKeys(
  statements: IdentityStatements,
  ids: readonly number[],
): Map<number, MoleculeKeys> {
  const out = new Map<number, MoleculeKeys>();
  for (let from = 0; from < ids.length; from += 10_000) {
    const rows = statements.keys.all(
      JSON.stringify(ids.slice(from, from + 10_000)),
    ) as Array<{
      id: bigint;
      noStereoHash: bigint;
      tautomerHash: bigint;
      idCode: string;
      idCodeHash: bigint;
    }>;
    for (const row of rows) {
      out.set(Number(row.id), {
        idCode: row.idCode,
        noStereoHash: row.noStereoHash,
        tautomerHash: row.tautomerHash,
        idCodeHash: row.idCodeHash,
      });
    }
  }
  return out;
}

/**
 * The ids holding each hash, in id order.
 * @param statements - The identity statements.
 * @param kind - Which hash.
 * @param hashes - The hashes.
 * @returns One id list per hash.
 */
export function idsByHashes(
  statements: IdentityStatements,
  kind: HashKind,
  hashes: readonly bigint[],
): number[][] {
  const statement = statements.byHash[kind];
  const out = new Array<number[]>(hashes.length);
  for (let i = 0; i < hashes.length; i++) {
    const rows = statement.all(hashes[i] as bigint) as Array<{ id: number }>;
    out[i] = rows.map((row) => row.id);
  }
  return out;
}

/**
 * A page of the ids holding one hash, in id order; none for a molecule without the hash.
 * @param statements - The identity statements.
 * @param kind - Which hash.
 * @param hash - The hash, or `NO_HASH`.
 * @param options - Paging.
 * @returns The ids.
 */
export function groupIds(
  statements: IdentityStatements,
  kind: HashKind,
  hash: bigint,
  options: GroupOptions,
): number[] {
  const { after = 0, limit = 1000 } = options;
  if (hash === NO_HASH) return [];
  return idsAfter(statements, kind, hash, after, limit);
}

/**
 * The ids holding one hash after a cursor, in id order.
 * @param statements - The identity statements.
 * @param kind - Which hash.
 * @param hash - The hash.
 * @param after - Only ids above it.
 * @param limit - At most this many.
 * @returns The ids.
 */
export function idsAfter(
  statements: IdentityStatements,
  kind: HashKind,
  hash: bigint,
  after: number,
  limit: number,
): number[] {
  const rows = statements.hashAfter[kind].all(hash, after, limit) as Array<{
    id: number;
  }>;
  return rows.map((row) => row.id);
}

/**
 * The stored molecules sharing a no-stereo hash, with their idCodes.
 * @param statements - The identity statements.
 * @param hash - The no-stereo hash.
 * @returns Their ids and canonical idCodes.
 */
export function sameNoStereo(
  statements: IdentityStatements,
  hash: bigint,
): Array<{ id: number; idCode: string }> {
  const rows = statements.idCodes.all(hash) as Array<{
    id: number;
    idCode: string;
  }>;
  return rows.map((row) => ({ id: row.id, idCode: row.idCode }));
}
