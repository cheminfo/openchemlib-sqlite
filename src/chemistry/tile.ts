/**
 * A tile: up to 32 molecules of one cell (an atom count and a 1 Da band of the library's own
 * weight), held as bit planes. Bit i of plane p is slot i; plane p is bit `p & 31` of word `p >> 5`
 * of a molecule's 48 words: FragFp (planes 0-511), the screen (512-1023), the function keys
 * (1024-1535). In memory a tile holds its 1,536 planes dense; `tileRecord.ts` stores it as the
 * `ocl_tile` record, its function planes sparse.
 */

/** Molecules per tile, and rows per plane word. */
export const SLOTS = 32;

/** Bit planes per molecule: FragFp (0-511), the screen (512-1023), the function keys (1024-1535). */
export const PLANES = 1536;

/** The FragFp planes, the first ones. */
export const FRAGFP_PLANES = 512;

/** The first function-key plane: the screen's planes end there. */
export const FUNCTION_PLANES_AT = 1024;

/** The function-key planes. */
export const FUNCTION_PLANES = 512;

/** 32-bit words per molecule: 16 FragFp, 16 screen, 16 function words, as getMoleculeRecords writes them. */
export const MOLECULE_WORDS = 48;

/** Where the parts of a tile record start; the record ends with the non-zero function plane words. */
export const SEQ_AT = 4096;
export const BITS_AT = 4224;
export const N_AT = 4288;
export const FUNCTION_MASK_AT = 4292;

/** Bytes of a tile record holding no function word: 4,356; each non-zero function plane word adds 4. */
export const TILE_FIXED_BYTES = 4356;

/** Bits of the tile key: atom count 16, band 16, tile seq 21 (53 in all). */
export const BAND_SPAN = 2 ** 16;
export const TILE_SPAN = 2 ** 21;
export const MAX_BAND = BAND_SPAN - 1;

/** Where the parts of a tile start in memory: the planes dense, then the seqs, counts and n. */
const DENSE_SEQ_AT = 4 * PLANES;
const DENSE_BITS_AT = DENSE_SEQ_AT + 4 * SLOTS;
const DENSE_N_AT = DENSE_BITS_AT + 2 * SLOTS;
const DENSE_BYTES = DENSE_N_AT + 4;

/** Typed views over one tile in memory, its planes dense. */
export interface TileViews {
  /** 1,536 plane words: FragFp, the screen, the function keys. */
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
 * An empty tile in memory: no slot used.
 * @returns Its views.
 */
export function newTile(): TileViews {
  const buffer = new ArrayBuffer(DENSE_BYTES);
  return {
    planes: new Int32Array(buffer, 0, PLANES),
    seqs: new Uint32Array(buffer, DENSE_SEQ_AT, SLOTS),
    bits: new Uint16Array(buffer, DENSE_BITS_AT, SLOTS),
    used: new Uint32Array(buffer, DENSE_N_AT, 1),
  };
}

/**
 * A copy of a tile, its own memory.
 * @param tile - The tile.
 * @returns The copy's views.
 */
export function copyTile(tile: TileViews): TileViews {
  const copy = newTile();
  copy.planes.set(tile.planes);
  copy.seqs.set(tile.seqs);
  copy.bits.set(tile.bits);
  copy.used[0] = tile.used[0] as number;
  return copy;
}

/**
 * Writes one molecule into the next slot of a tile.
 * @param tile - The tile, with a free slot.
 * @param words - The molecule's words: FragFp, the screen, the function keys.
 * @param offset - Where its 48 words start in `words`.
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
 * @param words - The molecule's words: FragFp, the screen, the function keys.
 * @param offset - Where its 48 words start in `words`.
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
 * The 48 words of one slot, read back from the planes.
 * @param tile - The tile.
 * @param slot - The slot.
 * @returns Its words: FragFp, the screen, the function keys.
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
