import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { FINGERPRINT_WORDS, countKeys } from '../chemistry/bits.ts';
import { MAX_SEQ, makeId } from '../chemistry/key.ts';
import type { RecordColumns } from '../chemistry/records.ts';
import type { TileViews } from '../chemistry/tile.ts';
import {
  MOLECULE_WORDS,
  SLOTS,
  TILE_BYTES,
  TILE_SPAN,
  addSlot,
  tileKey,
  tileViews,
} from '../chemistry/tile.ts';

import {
  COUNTED_BITS,
  COUNTS_AT,
  addCounts,
  prepareAddCount,
} from './bitCounts.ts';
import type { WriteCheck } from './writeState.ts';

/** Where a committed molecule landed. */
export interface CommitResult {
  /** Its id: atomCount·2^36 + seq. */
  id: number;
  /** True when this commit added it, false when the store already held it. */
  created: boolean;
}

/** The statements of the write path, prepared once per connection. */
export interface WriteStatements {
  meta: StatementSync;
  setMeta: StatementSync;
  addMeta: StatementSync;
  sameHash: StatementSync;
  sameTautomer: StatementSync;
  insertMolecule: StatementSync;
  lastTile: StatementSync;
  insertTile: StatementSync;
  updateTile: StatementSync;
  addCount: StatementSync;
}

/**
 * Prepares the statements of the write path.
 * @param db - The connection.
 * @returns The statements.
 */
export function prepareWriteStatements(db: DatabaseSync): WriteStatements {
  return {
    meta: db.prepare('SELECT value FROM ocl_meta WHERE name = ?'),
    setMeta: db.prepare('UPDATE ocl_meta SET value = ? WHERE name = ?'),
    addMeta: db.prepare('UPDATE ocl_meta SET value = value + ? WHERE name = ?'),
    sameHash: db.prepare(
      'SELECT id, idCode FROM ocl_molecule WHERE noStereoHash = ?',
    ),
    sameTautomer: db.prepare(
      'SELECT 1 AS found FROM ocl_molecule WHERE tautomerHash = ? LIMIT 1',
    ),
    insertMolecule: db.prepare(
      'INSERT INTO ocl_molecule (id, noStereoHash, tautomerHash, idCode, idCodeHash) VALUES (?, ?, ?, ?, ?)',
    ),
    lastTile: db.prepare(
      'SELECT id, data FROM ocl_tile WHERE id >= ? AND id < ? ORDER BY id DESC LIMIT 1',
    ),
    insertTile: db.prepare('INSERT INTO ocl_tile (id, data) VALUES (?, ?)'),
    updateTile: db.prepare('UPDATE ocl_tile SET data = ? WHERE id = ?'),
    addCount: prepareAddCount(db),
  };
}

interface OpenTile {
  key: number;
  tile: TileViews;
  isNew: boolean;
  dirty: boolean;
}

/**
 * Writes computed molecules into the store, inside the caller's transaction: a molecule the store
 * holds already (same no-stereo hash and same canonical idCode) gets its id back; a new one gets
 * the next seq, its `ocl_molecule` row and a slot in the open tile of its cell. Only the open tile
 * of each cell touched is rewritten, once. A new molecule whose no-stereo or tautomer hash no
 * stored molecule carries adds one to that distinct count: the no-stereo hash is told by the seek
 * that finds duplicates, the tautomer hash by one more seek. Each new molecule's bits are added
 * to the bit counts. While a rebuild is under way, each tile written is logged for it.
 * @param db - The connection, inside a transaction.
 * @param statements - Its write statements.
 * @param records - What the library computed.
 * @param writable - Refuses the write when the file cannot take it, else says what it keeps.
 * @returns Per molecule, where it landed; undefined for a molecule with an error.
 */
export function commitRecords(
  db: DatabaseSync,
  statements: WriteStatements,
  records: RecordColumns,
  writable: () => WriteCheck,
): Array<CommitResult | undefined> {
  if (!db.isTransaction) {
    throw new Error(
      'commit() runs inside the caller\'s transaction: call db.exec("BEGIN IMMEDIATE") first',
    );
  }
  const { counting, logging } = writable();
  const log = logging ? prepareTileLog(db) : null;
  const counts = new Float64Array(COUNTED_BITS);
  let seq = readNumber(statements, 'seq');
  const count = readNumber(statements, 'count');
  const tiles = new Map<number, OpenTile>();
  const results = new Array<CommitResult | undefined>(
    records.idCodes.length,
  ).fill(undefined);
  let created = 0;
  let newNoStereo = 0;
  let newTautomer = 0;
  for (let i = 0; i < records.idCodes.length; i++) {
    if (records.errors[i] !== null) continue;
    const idCode = records.idCodes[i] as string;
    const noStereoHash = records.noStereoHashes[i] as bigint;
    const tautomerHash = records.tautomerHashes[i] as bigint;
    const same = findSame(statements, noStereoHash, idCode);
    if (same.id !== undefined) {
      results[i] = { id: same.id, created: false };
      continue;
    }
    // Rows written earlier in this batch are in the table already, so a hash two new molecules
    // share is counted once.
    if (!same.hashSeen) newNoStereo++;
    if (statements.sameTautomer.get(tautomerHash) === undefined) newTautomer++;
    seq++;
    if (seq > MAX_SEQ) throw new Error(`seq ${seq} passes the tile's Uint32`);
    const atoms = records.atoms[i] as number;
    const id = makeId(atoms, seq);
    statements.insertMolecule.run(
      id,
      noStereoHash,
      tautomerHash,
      idCode,
      records.idCodeHashes[i] as bigint,
    );
    const open = openTile(
      statements,
      tiles,
      { atoms, band: records.bands[i] as number },
      log,
    );
    addSlot(
      open.tile,
      records.words,
      i * MOLECULE_WORDS,
      seq,
      records.bits[i] as number,
    );
    open.dirty = true;
    countMolecule(counts, records, i);
    results[i] = { id, created: true };
    created++;
  }
  for (const open of tiles.values()) flush(statements, open, log);
  if (created > 0) {
    addCounts(statements.addCount, counts, counting);
    statements.setMeta.run(seq, 'seq');
    statements.setMeta.run(count + created, 'count');
    statements.addMeta.run(newNoStereo, 'distinctNoStereo');
    statements.addMeta.run(newTautomer, 'distinctTautomer');
  }
  return results;
}

/**
 * Adds one molecule's FragFp, screen and function bits to the counts.
 * @param counts - The counts, in key order.
 * @param records - What the library computed.
 * @param i - The molecule.
 */
function countMolecule(
  counts: Float64Array,
  records: RecordColumns,
  i: number,
): void {
  const words = i * MOLECULE_WORDS;
  countKeys(counts, COUNTS_AT.fragFp, records.words, words, 1);
  countKeys(
    counts,
    COUNTS_AT.screen,
    records.words,
    words + FINGERPRINT_WORDS,
    1,
  );
  countKeys(
    counts,
    COUNTS_AT.functions,
    records.functions,
    i * FINGERPRINT_WORDS,
    1,
  );
}

/**
 * The stored molecule with this no-stereo hash and canonical idCode, and whether any stored
 * molecule carries the hash.
 * @param statements - The write statements.
 * @param noStereoHash - Its no-stereo hash.
 * @param idCode - Its canonical idCode.
 * @returns The id, or undefined; and whether the hash is stored already.
 */
export function findSame(
  statements: WriteStatements,
  noStereoHash: bigint,
  idCode: string,
): { id: number | undefined; hashSeen: boolean } {
  let hashSeen = false;
  for (const row of statements.sameHash.iterate(noStereoHash) as Iterable<{
    id: number;
    idCode: string;
  }>) {
    if (row.idCode === idCode) return { id: row.id, hashSeen: true };
    hashSeen = true;
  }
  return { id: undefined, hashSeen };
}

function readNumber(statements: WriteStatements, name: string): number {
  const row = statements.meta.get(name) as { value: unknown } | undefined;
  return Number(row?.value ?? 0);
}

/**
 * The statement logging a changed tile for the rebuild under way.
 * @param db - The connection.
 * @returns It, taking the tile's key.
 */
export function prepareTileLog(db: DatabaseSync): StatementSync {
  return db.prepare('INSERT INTO ocl_rebuild_tiles (id) VALUES (?)');
}

function openTile(
  statements: WriteStatements,
  tiles: Map<number, OpenTile>,
  cell: { atoms: number; band: number },
  log: StatementSync | null,
): OpenTile {
  const { atoms, band } = cell;
  const base = tileKey(atoms, band, 0);
  let open = tiles.get(base);
  if (open !== undefined && (open.tile.used[0] as number) < SLOTS) return open;
  let next = base;
  if (open === undefined) {
    const row = statements.lastTile.get(base, tileKey(atoms, band + 1, 0)) as
      { id: number; data: Uint8Array } | undefined;
    if (row !== undefined) {
      open = {
        key: row.id,
        tile: tileViews(row.data),
        isNew: false,
        dirty: false,
      };
      if ((open.tile.used[0] as number) < SLOTS) {
        tiles.set(base, open);
        return open;
      }
      next = open.key + 1;
    }
  } else {
    flush(statements, open, log);
    next = open.key + 1;
  }
  if (next - base >= TILE_SPAN) {
    throw new Error(`cell (${atoms}, ${band}) holds 2^21 tiles already`);
  }
  open = {
    key: next,
    tile: tileViews(new Uint8Array(TILE_BYTES)),
    isNew: true,
    dirty: true,
  };
  tiles.set(base, open);
  return open;
}

function flush(
  statements: WriteStatements,
  open: OpenTile,
  log: StatementSync | null,
): void {
  if (!open.dirty) return;
  if (open.isNew) statements.insertTile.run(open.key, open.tile.data);
  else statements.updateTile.run(open.tile.data, open.key);
  log?.run(open.key);
  open.isNew = false;
  open.dirty = false;
}
