import { popcount32 } from './bits.ts';
import type { TileViews } from './tile.ts';
import {
  BITS_AT,
  FUNCTION_MASK_AT,
  FUNCTION_PLANES,
  FUNCTION_PLANES_AT,
  N_AT,
  PLANES,
  SEQ_AT,
  SLOTS,
  TILE_FIXED_BYTES,
  newTile,
} from './tile.ts';

/*
 * The `ocl_tile` record, little endian:
 * - `[0, 4096)`: 1,024 Int32 plane words, FragFp (planes 0-511) then the screen (512-1023);
 * - `[4096, 4224)`: 32 Uint32 seqs, 0 for an empty or removed slot;
 * - `[4224, 4288)`: 32 Uint16 FragFp bit counts;
 * - `[4288, 4292)`: Uint32 n, the slots used, in arrival order;
 * - `[4292, 4356)`: 16 Uint32 words, the mask of the stored function planes: bit `p & 31` of word
 *   `p >> 5` is set when function plane p (tile plane 1024 + p) holds a non-zero word;
 * - `[4356, 4356 + 4k)`: those k non-zero plane words, in plane order.
 * A record is exactly `TILE_FIXED_BYTES + 4 × popcount(mask)` bytes, at most 6,404: about three
 * quarters of the function plane words of a full tile are zero.
 */

/** Words of the function mask, and where the mask and the stored words start, in 32-bit words. */
const MASK_WORDS = FUNCTION_PLANES / 32;
const MASK_WORD_AT = FUNCTION_MASK_AT / 4;
const STORED_WORD_AT = TILE_FIXED_BYTES / 4;

/**
 * The 32-bit words of a stored record, its length checked against its function mask.
 * @param blob - The record, as read from `ocl_tile.data`.
 * @returns Its words, over a 4-byte aligned copy when SQLite handed it unaligned.
 * @throws {Error} When its length does not match its mask: a record of a pre-release 6.0 build.
 */
export function recordWords(blob: Uint8Array): Int32Array {
  const data = blob.byteOffset % 4 === 0 ? blob : blob.slice();
  const n = data.byteLength;
  let expected = TILE_FIXED_BYTES;
  if (n >= TILE_FIXED_BYTES) {
    const mask = new Int32Array(
      data.buffer,
      data.byteOffset + FUNCTION_MASK_AT,
      MASK_WORDS,
    );
    for (let m = 0; m < MASK_WORDS; m++) {
      expected += 4 * popcount32(mask[m] as number);
    }
  }
  if (n !== expected) {
    throw new Error(
      `a tile holds ${expected} bytes for its function mask, not ${n}: a file of a pre-release 6.0 build, which this build refuses`,
    );
  }
  return new Int32Array(data.buffer, data.byteOffset, n / 4);
}

/**
 * Writes the function planes of a stored record into dense planes: tile plane `1024 + p` goes to
 * `target[(1024 + p) * stride + at]`, ANDed with `mask`. The planes the record leaves out (zero
 * words) are not written: the target must hold zeros there.
 * @param record - The record's words, from {@link recordWords}.
 * @param target - The planes written, plane-major.
 * @param stride - Words per plane in `target`.
 * @param at - The word of each plane written.
 * @param mask - The slots kept.
 */
export function scatterFunctionPlanes(
  record: Int32Array,
  target: Int32Array,
  stride: number,
  at: number,
  mask: number,
): void {
  let k = STORED_WORD_AT;
  for (let m = 0; m < MASK_WORDS; m++) {
    let bits = record[MASK_WORD_AT + m] as number;
    while (bits !== 0) {
      const lowest = bits & -bits;
      const plane = FUNCTION_PLANES_AT + 32 * m + 31 - Math.clz32(lowest);
      target[plane * stride + at] = (record[k++] as number) & mask;
      bits ^= lowest;
    }
  }
}

/**
 * Reads a stored record into a tile in memory, every plane written.
 * @param blob - The record, as read from `ocl_tile.data`.
 * @param tile - The tile written.
 * @returns The tile.
 */
export function readTile(blob: Uint8Array, tile: TileViews): TileViews {
  const record = recordWords(blob);
  const { planes, seqs, bits, used } = tile;
  planes.set(record.subarray(0, FUNCTION_PLANES_AT));
  planes.fill(0, FUNCTION_PLANES_AT);
  scatterFunctionPlanes(record, planes, 1, 0, -1);
  const { buffer, byteOffset } = record;
  seqs.set(new Uint32Array(buffer, byteOffset + SEQ_AT, SLOTS));
  bits.set(new Uint16Array(buffer, byteOffset + BITS_AT, SLOTS));
  used[0] = record[N_AT / 4] as number;
  return tile;
}

/**
 * A stored record, decoded into a tile of its own.
 * @param blob - The record, as read from `ocl_tile.data`.
 * @returns The tile, its planes dense.
 */
export function tileViews(blob: Uint8Array): TileViews {
  return readTile(blob, newTile());
}

/**
 * The record a tile is stored as: its fixed part, then its non-zero function plane words.
 * @param tile - The tile.
 * @returns The record.
 */
export function tileBytes(tile: TileViews): Uint8Array {
  const { planes, seqs, bits, used } = tile;
  let stored = 0;
  for (let p = FUNCTION_PLANES_AT; p < PLANES; p++) {
    if (planes[p] !== 0) stored++;
  }
  const data = new Uint8Array(TILE_FIXED_BYTES + 4 * stored);
  const words = new Int32Array(data.buffer);
  words.set(planes.subarray(0, FUNCTION_PLANES_AT));
  new Uint32Array(data.buffer, SEQ_AT, SLOTS).set(seqs);
  new Uint16Array(data.buffer, BITS_AT, SLOTS).set(bits);
  words[N_AT / 4] = used[0] as number;
  let k = STORED_WORD_AT;
  for (let p = 0; p < FUNCTION_PLANES; p++) {
    const word = planes[FUNCTION_PLANES_AT + p] as number;
    if (word === 0) continue;
    const at = MASK_WORD_AT + (p >>> 5);
    words[at] = (words[at] as number) | (1 << (p & 31));
    words[k++] = word;
  }
  return data;
}
