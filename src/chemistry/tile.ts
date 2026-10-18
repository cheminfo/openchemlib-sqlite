/**
 * The `ocl_tile` record: up to 32 molecules of one cell (an atom count and a 1 Da band of the
 * library's own weight), stored as bit planes. Fixed size, little endian:
 * - `[0, 4096)`: 1,024 Int32 plane words, bit-major, bit i of plane p being slot i. Plane p is bit
 * `p & 31` of word `p >> 5` of a molecule's 32 words: FragFp (planes 0-511), then the screen
 * (planes 512-1023);
 * - `[4096, 4224)`: 32 Uint32 seqs, 0 for an empty or removed slot;
 * - `[4224, 4288)`: 32 Uint16 FragFp bit counts;
 * - `[4288, 4292)`: Uint32 n, the slots used, in arrival order.
 */

/** Molecules per tile, and rows per plane word. */
export const SLOTS = 32;

/** Bit planes per molecule: FragFp then the screen. */
export const PLANES = 1024;

/** The FragFp planes, the first ones. */
export const FRAGFP_PLANES = 512;

/** 32-bit words per molecule: 16 FragFp words then 16 screen words. */
export const MOLECULE_WORDS = 32;

/** Bytes of a tile record, and where its parts start. */
export const TILE_BYTES = 4292;
export const SEQ_AT = 4096;
export const BITS_AT = 4224;
export const N_AT = 4288;

/** Bits of the tile key: atom count 16, band 16, tile seq 21 (53 in all). */
export const BAND_SPAN = 2 ** 16;
export const TILE_SPAN = 2 ** 21;
export const MAX_BAND = BAND_SPAN - 1;

/** Typed views over one tile record. */
export interface TileViews {
  /** The record itself, 4-byte aligned. */
  data: Uint8Array;
  /** 1,024 plane words. */
  planes: Int32Array;
  /** 32 seqs. */
  seqs: Uint32Array;
  /** 32 FragFp bit counts. */
  bits: Uint16Array;
  /** One word: the slots used. */
  used: Uint32Array;
}

/**
 * The key of a tile.
 * @param atoms - The atom count.
 * @param band - The band, 0 to 65,535.
 * @param tileSeq - The tile's rank in its cell.
 * @returns (atoms·2^16 + band)·2^21 + tileSeq.
 */
export function tileKey(atoms: number, band: number, tileSeq: number): number {
  return (atoms * BAND_SPAN + band) * TILE_SPAN + tileSeq;
}

/**
 * The parts of a tile key.
 * @param key - The key.
 * @returns Its atom count, band and tile seq.
 */
export function splitTileKey(key: number): {
  atoms: number;
  band: number;
  tileSeq: number;
} {
  const cell = Math.floor(key / TILE_SPAN);
  return {
    atoms: Math.floor(cell / BAND_SPAN),
    band: cell % BAND_SPAN,
    tileSeq: key - cell * TILE_SPAN,
  };
}

/**
 * The band of a weight: its floor in Da, clamped to 0..65,535 (0 for a weight that is not a
 * number). The band only places a molecule: results are ordered by the caller's key.
 * @param weight - OpenChemLib's relative weight of the molecule.
 * @returns The band.
 */
export function bandOfWeight(weight: number): number {
  if (!(weight >= 0)) return 0;
  return weight >= MAX_BAND ? MAX_BAND : Math.floor(weight);
}

/**
 * Typed views over a tile record, copying it when SQLite handed it unaligned.
 * @param blob - The record, as read from `ocl_tile.data`, or a fresh one.
 * @returns The views.
 */
export function tileViews(blob: Uint8Array): TileViews {
  if (blob.byteLength !== TILE_BYTES) {
    throw new Error(`a tile holds ${TILE_BYTES} bytes, not ${blob.byteLength}`);
  }
  const data = blob.byteOffset % 4 === 0 ? blob : blob.slice();
  const { buffer, byteOffset } = data;
  return {
    data,
    planes: new Int32Array(buffer, byteOffset, PLANES),
    seqs: new Uint32Array(buffer, byteOffset + SEQ_AT, SLOTS),
    bits: new Uint16Array(buffer, byteOffset + BITS_AT, SLOTS),
    used: new Uint32Array(buffer, byteOffset + N_AT, 1),
  };
}

/**
 * Writes one molecule into the next slot of a tile.
 * @param tile - The tile, with a free slot.
 * @param words - The molecule's words: FragFp then the screen.
 * @param offset - Where its 32 words start in `words`.
 * @param seq - Its seq.
 * @param bits - Its FragFp bit count.
 * @returns The slot it took.
 */
export function addSlot(
  tile: TileViews,
  words: Int32Array,
  offset: number,
  seq: number,
  bits: number,
): number {
  const slot = tile.used[0] as number;
  if (slot >= SLOTS) throw new Error('the tile is full');
  writeSlot(tile, slot, words, offset, seq, bits);
  tile.used[0] = slot + 1;
  return slot;
}

/**
 * Writes one molecule into a given slot of a tile, whose bits must be clear; how many slots the
 * tile uses is left as it is.
 * @param tile - The tile.
 * @param slot - The slot.
 * @param words - The molecule's words: FragFp then the screen.
 * @param offset - Where its 32 words start in `words`.
 * @param seq - Its seq.
 * @param bits - Its FragFp bit count.
 */
export function writeSlot(
  tile: TileViews,
  slot: number,
  words: Int32Array,
  offset: number,
  seq: number,
  bits: number,
): void {
  const bit = 1 << slot;
  const { planes, seqs, bits: counts } = tile;
  for (let word = 0; word < MOLECULE_WORDS; word++) {
    let value = words[offset + word] as number;
    while (value !== 0) {
      const lowest = value & -value;
      const plane = 32 * word + 31 - Math.clz32(lowest);
      planes[plane] = (planes[plane] as number) | bit;
      value ^= lowest;
    }
  }
  seqs[slot] = seq;
  counts[slot] = bits;
}

/**
 * Empties a slot (a removed molecule): its bits, seq and bit count are cleared, the slot stays
 * used, so no later molecule takes it.
 * @param tile - The tile.
 * @param slot - The slot.
 */
export function clearSlot(tile: TileViews, slot: number): void {
  const mask = ~(1 << slot);
  const { planes, seqs, bits } = tile;
  for (let plane = 0; plane < PLANES; plane++) {
    planes[plane] = (planes[plane] as number) & mask;
  }
  seqs[slot] = 0;
  bits[slot] = 0;
}

/**
 * A copy of a tile, its own memory.
 * @param tile - The tile.
 * @returns The copy's views.
 */
export function copyTile(tile: TileViews): TileViews {
  return tileViews(tile.data.slice());
}

/**
 * The 32 words of one slot, read back from the planes.
 * @param tile - The tile.
 * @param slot - The slot.
 * @returns Its words: FragFp then the screen.
 */
export function slotWords(tile: TileViews, slot: number): Int32Array {
  const words = new Int32Array(MOLECULE_WORDS);
  const { planes } = tile;
  for (let plane = 0; plane < PLANES; plane++) {
    if ((((planes[plane] as number) >>> slot) & 1) !== 0) {
      const word = plane >>> 5;
      words[word] = (words[word] as number) | (1 << (plane & 31));
    }
  }
  return words;
}
