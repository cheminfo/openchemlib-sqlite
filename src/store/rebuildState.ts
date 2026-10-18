import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { Signatures } from '../chemistry/stamp.ts';

import type { CountedFingerprint } from './bitCounts.ts';
import { COUNTS_AT, FINGERPRINT_BITS } from './bitCounts.ts';
import { dropInSteps } from './dropInSteps.ts';
import {
  CHANGED_TILES_SQL,
  NEXT_COUNTS_SQL,
  NEXT_TILES_SQL,
  REMOVED_SQL,
} from './rebuildSchema.ts';
import {
  ID_CODE_HASH_INDEX_SQL,
  countedRows,
  hasColumn,
  hasTable,
  readMeta,
  signatureRows,
} from './schema.ts';

/** Where a rebuild under way is. */
export interface RebuildPosition {
  /** This run's token: a step finding another one stops. */
  token: string;
  /** The last tile key the first pass built. */
  cursor: number;
  /** Molecules done so far. */
  done: number;
  /** Whether the first pass is over: only the log of changes is left. */
  scanned: boolean;
  /** The last id whose idCode hash the hash pass wrote. */
  hashCursor: number;
  /** The last seq when the hash pass began: molecules above it are hashed at the switch. */
  hashFrom: number;
  /** Whether the hash pass is over. */
  hashed: boolean;
}

/** What a rebuild changes. */
export interface RebuildPlan {
  /** The fingerprints whose tiles are computed again. */
  tiles: Array<'fragFp' | 'screen'>;
  /** The fingerprints counted again. */
  counts: CountedFingerprint[];
  /** Whether the idCode hashes are written again, the column and its index added when missing. */
  idCodeHash: boolean;
}

/** The meta rows of a rebuild under way. */
const REBUILD_ROWS = [
  'rebuild',
  'rebuild.cursor',
  'rebuild.done',
  'rebuild.scanned',
  'rebuild.token',
  'rebuild.hashCursor',
  'rebuild.hashFrom',
  'rebuild.hashed',
];

/** The tables of a rebuild under way, beside the new tiles. */
const REBUILD_TABLES = [
  'ocl_bits_next',
  'ocl_rebuild_tiles',
  'ocl_rebuild_removed',
];

/**
 * Starts the rebuild, or takes over the one under way for the same build: creates the new tiles
 * and counts when they are rebuilt, the logs the writes fill meanwhile, and the idCode hash column
 * with its index when the file lacks them; building that index holds the write lock for as long.
 * @param db - The connection, outside any transaction.
 * @param target - What the rebuild brings the file to.
 * @param plan - What it rebuilds.
 * @returns Where it is.
 */
export function beginRebuild(
  db: DatabaseSync,
  target: string,
  plan: RebuildPlan,
): RebuildPosition {
  const token = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const values = metaValues(db);
    const set = prepareSetMeta(db);
    const position: RebuildPosition = {
      token,
      cursor: -1,
      done: 0,
      scanned: plan.tiles.length === 0 && plan.counts.length === 0,
      hashCursor: -1,
      hashFrom: 0,
      hashed: !plan.idCodeHash,
    };
    if (values.get('rebuild') === target) {
      position.cursor = Number(values.get('rebuild.cursor') ?? -1);
      position.done = Number(values.get('rebuild.done') ?? 0);
      position.scanned = Number(values.get('rebuild.scanned') ?? 1) === 1;
      position.hashCursor = Number(values.get('rebuild.hashCursor') ?? -1);
      position.hashFrom = Number(values.get('rebuild.hashFrom') ?? 0);
      position.hashed = Number(values.get('rebuild.hashed') ?? 1) === 1;
    } else {
      if (values.has('rebuild')) {
        throw new Error(
          'a rebuild for another build is under way: let it end, or call MoleculeStore.abandonRebuild()',
        );
      }
      dropTables(db);
      if (!position.scanned) {
        db.exec(NEXT_TILES_SQL);
        for (const sql of NEXT_COUNTS_SQL) db.exec(sql);
      }
      if (plan.idCodeHash) {
        if (!hasColumn(db, 'ocl_molecule', 'idCodeHash')) {
          db.exec(
            'ALTER TABLE ocl_molecule ADD COLUMN idCodeHash INTEGER NOT NULL DEFAULT 0',
          );
        }
        db.exec(ID_CODE_HASH_INDEX_SQL);
        position.hashFrom = readMeta(db).seq;
      }
      db.exec(CHANGED_TILES_SQL);
      db.exec(REMOVED_SQL);
      set.run('rebuild', target);
      set.run('rebuild.cursor', -1);
      set.run('rebuild.done', 0);
      set.run('rebuild.scanned', position.scanned ? 1 : 0);
      set.run('rebuild.hashCursor', -1);
      set.run('rebuild.hashFrom', position.hashFrom);
      set.run('rebuild.hashed', position.hashed ? 1 : 0);
    }
    set.run('rebuild.token', token);
    db.exec('COMMIT');
    return position;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Puts the new tiles and counts in place, inside the caller's transaction, once the log is empty:
 * the tiles in use are renamed aside (freed afterwards, a step at a time), the new ones take their
 * name, the counts of the rebuilt fingerprints replace theirs, and the file takes this build's
 * stamp, signatures and a new generation.
 * @param db - The connection, inside the write transaction that emptied the log.
 * @param plan - What was rebuilt.
 * @param to - What the file now is.
 * @param to.stamp - This build's stamp.
 * @param to.signatures - This build's signatures.
 */
export function finishRebuild(
  db: DatabaseSync,
  plan: RebuildPlan,
  to: { stamp: string; signatures: Signatures },
): void {
  if (hasTable(db, 'ocl_tile_next')) {
    db.exec('ALTER TABLE ocl_tile RENAME TO ocl_tile_old');
    db.exec('ALTER TABLE ocl_tile_next RENAME TO ocl_tile');
  }
  if (plan.counts.length > 0) {
    const copy = db.prepare(
      `UPDATE ocl_bits SET population =
        (SELECT population FROM ocl_bits_next n WHERE n.bit = ocl_bits.bit)
        WHERE bit >= ? AND bit < ?`,
    );
    for (const fingerprint of plan.counts) {
      const at = COUNTS_AT[fingerprint];
      copy.run(at, at + FINGERPRINT_BITS);
    }
  }
  dropTables(db);
  const counted = new Map(countedRows(to.signatures));
  const set = prepareSetMeta(db);
  set.run('stamp', to.stamp);
  db.exec("UPDATE ocl_meta SET value = value + 1 WHERE name = 'generation'");
  for (const [name, value] of signatureRows(to.signatures)) {
    set.run(name, value);
  }
  for (const fingerprint of plan.counts) {
    const name = `counted.${fingerprint}`;
    set.run(name, counted.get(name) as string);
  }
  deleteRebuildRows(db);
}

/**
 * Stops a rebuild under way and throws away what it built: the writes stop logging.
 * @param db - The application's connection, outside any transaction.
 * @returns Once the tiles it built are freed.
 */
export async function abandonRebuild(db: DatabaseSync): Promise<void> {
  db.exec('BEGIN IMMEDIATE');
  try {
    deleteRebuildRows(db);
    dropTables(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  await dropInSteps(db, 'ocl_tile_next');
}

/**
 * Refuses to go on when another run took the rebuild over.
 * @param statement - Reads the token.
 * @param token - This run's.
 */
export function checkToken(statement: StatementSync, token: string): void {
  const row = statement.get() as { value: unknown } | undefined;
  if (row?.value !== token) {
    throw new Error('another rebuild took this one over');
  }
}

/**
 * The statement writing a meta row.
 * @param db - The connection.
 * @returns It, taking the name and the value.
 */
export function prepareSetMeta(db: DatabaseSync): StatementSync {
  return db.prepare(
    'INSERT OR REPLACE INTO ocl_meta (name, value) VALUES (?, ?)',
  );
}

function deleteRebuildRows(db: DatabaseSync): void {
  const remove = db.prepare('DELETE FROM ocl_meta WHERE name = ?');
  for (const name of REBUILD_ROWS) remove.run(name);
}

function dropTables(db: DatabaseSync): void {
  for (const table of REBUILD_TABLES) {
    if (hasTable(db, table)) db.exec(`DROP TABLE ${table}`);
  }
}

function metaValues(db: DatabaseSync): Map<string, unknown> {
  const rows = db.prepare('SELECT name, value FROM ocl_meta').all() as Array<{
    name: string;
    value: unknown;
  }>;
  return new Map(rows.map((row) => [row.name, row.value]));
}
