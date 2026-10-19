import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { getMoleculeSizes } from 'openchemlib-search-wasm';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import { bandOfWeight, newTile, tileKey } from '../../chemistry/tile.ts';
import { readTile } from '../../chemistry/tileRecord.ts';
import type { NormalizedSpec } from '../spec.ts';
import { memberParameters } from '../spec.ts';

import type { TailSet } from './tailBitmaps.ts';
import type { TailBand, TailSegment } from './tailState.ts';
import type { TailStore } from './tailStore.ts';

/** The tail's statements on its read connection. */
export interface TailStatements {
  first: StatementSync;
  fresh: StatementSync;
  tiles: StatementSync;
  columns: StatementSync;
  members: Map<string, StatementSync>;
}

/**
 * Prepares the tail's statements.
 * @param db - The tail's read connection.
 * @param spec - The application's specification.
 * @returns The statements.
 */
export function prepareTailStatements(
  db: DatabaseSync,
  spec: NormalizedSpec,
): TailStatements {
  const tiles = db.prepare(
    'SELECT id, data FROM ocl_tile WHERE id >= ? AND id < ? ORDER BY id',
  );
  tiles.setReturnArrays(true);
  const columns = db.prepare(spec.columnsSql);
  columns.setReturnArrays(true);
  const members = new Map<string, StatementSync>();
  for (const family of spec.families) {
    const statement = db.prepare(family.members);
    statement.setReturnArrays(true);
    members.set(family.family, statement);
  }
  return {
    first: db.prepare(
      'SELECT id FROM ocl_molecule WHERE id >= ? ORDER BY id LIMIT 1',
    ),
    fresh: db.prepare(
      'SELECT id, idCode FROM ocl_molecule WHERE id > ? AND id < ? ORDER BY id',
    ),
    tiles,
    columns,
    members,
  };
}

/**
 * The molecules above the watermark, atom count by atom count (one seek each): each one's band is
 * computed from its idCode, the cell's tiles are read from the first one the image may lack, and
 * every new slot goes to its band's append area with its columns and its sets.
 * @param store - The tail store.
 * @param statements - The tail's statements.
 * @param watermark - The highest seq the image holds.
 * @param cap - The highest seq this poll reads.
 * @returns How many molecules were placed, and how many no tile slot held.
 */
export function readNewRows(
  store: TailStore,
  statements: TailStatements,
  watermark: number,
  cap: number,
): { placed: number; anomalies: number } {
  let placed = 0;
  let anomalies = 0;
  const found: number[] = [];
  for (let cursor = 0; ;) {
    const row = statements.first.get(cursor) as { id: number } | undefined;
    if (row === undefined) break;
    const { id } = row;
    const atoms = Math.floor(id / SEQ_SPAN);
    if (id - atoms * SEQ_SPAN > watermark) {
      found.push(atoms);
      cursor = (atoms + 1) * SEQ_SPAN;
    } else {
      cursor = atoms * SEQ_SPAN + watermark + 1;
    }
  }
  for (const atoms of found) {
    const lo = atoms * SEQ_SPAN + watermark;
    const hi = Math.min((atoms + 1) * SEQ_SPAN, atoms * SEQ_SPAN + cap + 1);
    const fresh = statements.fresh.all(lo, hi) as Array<{
      id: number;
      idCode: string;
    }>;
    if (fresh.length === 0) continue;
    const { weights } = getMoleculeSizes(fresh.map((row) => row.idCode));
    const byBand = new Map<number, Set<number>>();
    for (let i = 0; i < fresh.length; i++) {
      const band = bandOfWeight(weights[i] as number);
      let seqs = byBand.get(band);
      if (seqs === undefined) byBand.set(band, (seqs = new Set()));
      seqs.add((fresh[i] as { id: number }).id - atoms * SEQ_SPAN);
    }
    const columns = new Map<number, unknown[]>();
    for (const row of statements.columns.all({
      from: lo + 1,
      to: hi - 1,
    }) as unknown as unknown[][]) {
      columns.set(Number(row[0]), row);
    }
    const members = readMembers(store, statements, lo + 1, hi - 1);
    const segment = store.segmentOf(atoms);
    for (const [bandNumber, seqs] of [...byBand].toSorted(
      (a, b) => a[0] - b[0],
    )) {
      const band = store.bandOf(segment, bandNumber);
      const wanted = seqs.size;
      readCell(store, statements, segment, band, {
        seqs,
        watermark,
        cap,
        columns,
        members,
      });
      placed += wanted - seqs.size;
      anomalies += seqs.size;
      store.touch(atoms, bandNumber);
    }
    store.indexRows(segment);
  }
  return { placed, anomalies };
}

interface CellRead {
  seqs: Set<number>;
  watermark: number;
  cap: number;
  columns: Map<number, unknown[]>;
  members: Array<{ set: TailSet; ids: Set<number> }>;
}

function readCell(
  store: TailStore,
  statements: TailStatements,
  segment: TailSegment,
  band: TailBand,
  read: CellRead,
): void {
  const { atoms } = segment;
  const base = atoms * SEQ_SPAN;
  let tileSeq = band.tailFrom;
  let pending = -1;
  const tile = newTile();
  const { planes, seqs, bits: counts } = tile;
  const from = tileKey(atoms, band.band, band.tailFrom);
  for (const [rawId, blob] of statements.tiles.iterate(
    from,
    tileKey(atoms, band.band + 1, 0),
  ) as Iterable<[number, Uint8Array]>) {
    tileSeq = rawId - tileKey(atoms, band.band, 0);
    readTile(blob, tile);
    const used = tile.used[0] as number;
    for (let i = 0; i < used; i++) {
      const seq = seqs[i] as number;
      if (seq > read.cap && pending < 0) pending = tileSeq;
      if (seq <= read.watermark || seq > read.cap) continue;
      if (!read.seqs.delete(seq)) continue;
      const id = base + seq;
      const g = store.appendRow(
        segment,
        band,
        planes,
        i,
        seq,
        counts[i] as number,
        read.columns.get(id) ?? null,
      );
      if (store.bitmaps.isAlive(g)) {
        // The set's current words: an append block may have grown the bitmaps since.
        for (const { set, ids } of read.members) {
          if (ids.has(id)) Atomics.or(set.words, g >>> 5, 1 << (g & 31));
        }
      }
    }
  }
  band.tailFrom = pending >= 0 ? pending : tileSeq;
}

function readMembers(
  store: TailStore,
  statements: TailStatements,
  from: number,
  to: number,
): Array<{ set: TailSet; ids: Set<number> }> {
  const out: Array<{ set: TailSet; ids: Set<number> }> = [];
  for (const set of store.bitmaps.sets.values()) {
    const statement = statements.members.get(set.family) as StatementSync;
    const parameters = memberParameters(set.value, from, to);
    const ids = new Set<number>();
    for (const row of statement.all(parameters) as unknown as unknown[][]) {
      ids.add(Number(row[0]));
    }
    if (ids.size > 0) out.push({ set, ids });
  }
  return out;
}
