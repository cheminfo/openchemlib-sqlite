import type { DatabaseSync } from 'node:sqlite';

import { XSadd } from 'ml-xsadd';
import { strongHash } from 'openchemlib-search-wasm';

import { FINGERPRINT_WORDS, FUNCTION_WORDS_AT } from '../chemistry/bits.ts';
import { SEQ_SPAN, atomCountOf, seqOf } from '../chemistry/key.ts';
import {
  MOLECULE_WORDS,
  TILE_SPAN,
  slotWords,
  tileKey,
} from '../chemistry/tile.ts';
import { tileViews } from '../chemistry/tileRecord.ts';

import type { ChemistryPool } from './chemistryPool.ts';

/** A stored molecule that does not hold what this build computes from its idCode. */
export interface CheckMismatch {
  /** Its id. */
  id: number;
  /** What differs. */
  what: string[];
}

/**
 * The error refusing a store whose sample differs.
 * @param mismatches - What the sample found, at least one.
 * @returns The error.
 */
export function mismatchError(mismatches: CheckMismatch[]): Error {
  const first = mismatches[0] as CheckMismatch;
  return new Error(
    `${mismatches.length} sampled molecules do not hold what this build computes (id ${first.id}: ${first.what.join(', ')})`,
  );
}

/**
 * Recomputes a seeded sample of stored molecules from their idCodes and compares every stored
 * value: the atom count in the id, both identity hashes, the canonical idCode and the hash of the
 * one stored, the cell of its tile slot, its 1,536 bits and its bit count. OCL's canonical idCode of a few molecules flips
 * between two forms, each canonicalizing to the other (PubChem CID 9942100): an idCode that
 * differs alone is accepted when canonicalizing it again gives back the stored one.
 * @param db - The connection.
 * @param pool - The chemistry workers.
 * @param rows - How many molecules to sample.
 * @param seed - The sample's seed.
 * @returns The mismatches, empty when the sample holds what this build computes.
 */
export async function checkSample(
  db: DatabaseSync,
  pool: ChemistryPool,
  rows: number,
  seed: number,
): Promise<CheckMismatch[]> {
  const sample = sampleRows(db, rows, seed);
  if (sample.length === 0) return [];
  const records = await pool.records(sample.map((row) => row.idCode));
  const cellTiles = db.prepare(
    'SELECT data FROM ocl_tile WHERE id >= ? AND id < ? ORDER BY id',
  );
  const mismatches: CheckMismatch[] = [];
  const flipped: Array<{
    mismatch: CheckMismatch;
    stored: string;
    again: string;
  }> = [];
  for (let i = 0; i < sample.length; i++) {
    const row = sample[i] as SampledRow;
    const what: string[] = [];
    if (records.errors[i] !== null) what.push(records.errors[i] as string);
    if (records.idCodes[i] !== row.idCode) what.push('idCode');
    if (records.atoms[i] !== atomCountOf(row.id)) what.push('atom count');
    if (records.noStereoHashes[i] !== row.noStereoHash) {
      what.push('noStereoHash');
    }
    if (records.tautomerHashes[i] !== row.tautomerHash) {
      what.push('tautomerHash');
    }
    // The hash of the idCode stored, which a flipping pair keeps however it canonicalizes now.
    if (strongHash(row.idCode) !== row.idCodeHash) what.push('idCodeHash');
    const base = tileKey(atomCountOf(row.id), records.bands[i] as number, 0);
    const slot = findSlot(cellTiles.all(base, base + TILE_SPAN), seqOf(row.id));
    if (slot === undefined) {
      what.push('tile slot (band)');
    } else {
      const words = records.words.subarray(
        i * MOLECULE_WORDS,
        (i + 1) * MOLECULE_WORDS,
      );
      for (let word = 0; word < MOLECULE_WORDS; word++) {
        if (slot.words[word] !== words[word]) {
          what.push(wordPart(word));
          break;
        }
      }
      if (slot.bits !== records.bits[i]) what.push('bit count');
    }
    if (what.length === 0) continue;
    const mismatch = { id: row.id, what };
    mismatches.push(mismatch);
    if (what.length === 1 && what[0] === 'idCode') {
      flipped.push({
        mismatch,
        stored: row.idCode,
        again: records.idCodes[i] as string,
      });
    }
  }
  if (flipped.length === 0) return mismatches;
  const again = await pool.records(flipped.map((entry) => entry.again));
  const accepted = new Set<CheckMismatch>();
  for (const [k, entry] of flipped.entries()) {
    if (again.idCodes[k] === entry.stored) accepted.add(entry.mismatch);
  }
  return mismatches.filter((mismatch) => !accepted.has(mismatch));
}

interface SampledRow {
  id: number;
  idCode: string;
  noStereoHash: bigint;
  tautomerHash: bigint;
  idCodeHash: bigint;
}

function sampleRows(
  db: DatabaseSync,
  rows: number,
  seed: number,
): SampledRow[] {
  // One bucket per atom count: a seeded bucket, then a seeded seq in it, so every atom count is
  // drawn alike whatever the gaps between their ids.
  const first = db.prepare(
    'SELECT id FROM ocl_molecule WHERE id >= ? ORDER BY id LIMIT 1',
  );
  const last = db.prepare(
    'SELECT max(id) AS id FROM ocl_molecule WHERE id < ?',
  );
  const buckets: Array<{ low: number; high: number }> = [];
  for (let cursor = 0; ;) {
    const row = first.get(cursor) as { id: number } | undefined;
    if (row === undefined) break;
    const atoms = atomCountOf(row.id);
    const high = (last.get((atoms + 1) * SEQ_SPAN) as { id: number }).id;
    buckets.push({ low: row.id, high });
    cursor = (atoms + 1) * SEQ_SPAN;
  }
  const read = db.prepare(
    'SELECT id, noStereoHash, tautomerHash, idCode, idCodeHash FROM ocl_molecule WHERE id >= ? ORDER BY id LIMIT 1',
  );
  read.setReadBigInts(true);
  const generator = new XSadd(seed);
  const out = new Map<number, SampledRow>();
  for (
    let draw = 0;
    draw < 4 * rows && out.size < rows && buckets.length > 0;
    draw++
  ) {
    const bucket = buckets[
      Math.floor(generator.getFloat() * buckets.length)
    ] as { low: number; high: number };
    const at =
      bucket.low +
      Math.floor(generator.getFloat() * (bucket.high - bucket.low + 1));
    const row = read.get(at) as
      | {
          id: bigint;
          noStereoHash: bigint;
          tautomerHash: bigint;
          idCode: string;
          idCodeHash: bigint;
        }
      | undefined;
    if (row === undefined) continue;
    const id = Number(row.id);
    out.set(id, {
      id,
      idCode: row.idCode,
      noStereoHash: row.noStereoHash,
      tautomerHash: row.tautomerHash,
      idCodeHash: row.idCodeHash,
    });
  }
  return [...out.values()];
}

function findSlot(
  tiles: unknown[],
  seq: number,
): { words: Int32Array; bits: number } | undefined {
  for (const row of tiles as Array<{ data: Uint8Array }>) {
    const tile = tileViews(row.data);
    for (let slot = 0; slot < (tile.used[0] as number); slot++) {
      if (tile.seqs[slot] === seq) {
        return {
          words: slotWords(tile, slot),
          bits: tile.bits[slot] as number,
        };
      }
    }
  }
  return undefined;
}

/**
 * The fingerprint a word of a molecule's 48 belongs to.
 * @param word - The word.
 * @returns 'FragFp', 'screen' or 'functions'.
 */
function wordPart(word: number): string {
  if (word < FINGERPRINT_WORDS) return 'FragFp';
  return word < FUNCTION_WORDS_AT ? 'screen' : 'functions';
}
