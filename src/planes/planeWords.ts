/**
 * Word-at-a-time operations on plane chunks: a plane is a byte array, one bit
 * per slot, read here as 32-bit words so an intersection does a quarter of the
 * work a byte loop does, and only on the words that still hold a survivor once
 * few remain.
 */

import { bitCount } from '../utils/fingerprintBits.ts';

/**
 * Whether a 32-bit view of a plane puts its first byte in the low bits, which
 * decides which slot a bit of a word stands for.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * A plane as 32-bit words, without copying it when SQLite handed back a
 * buffer that can be viewed that way.
 *
 * A plane trimmed to a partial chunk can end mid-word; its last word is
 * completed with zeros, which no slot of the chunk uses.
 * @param blob - The plane as SQLite returned it.
 * @param scratch - An aligned buffer to copy into when it cannot be viewed.
 * @returns The plane's words.
 */
export function asWords(blob: Uint8Array, scratch: Uint32Array): Uint32Array {
  if (blob.byteOffset % 4 === 0 && blob.length % 4 === 0) {
    return new Uint32Array(blob.buffer, blob.byteOffset, blob.length / 4);
  }
  const words = Math.ceil(blob.length / 4);
  const bytes = new Uint8Array(scratch.buffer, 0, words * 4);
  bytes.fill(0, blob.length);
  bytes.set(blob);
  return scratch.subarray(0, words);
}

/**
 * AND a plane into the accumulator over every word.
 * @param accumulator - The running intersection, changed in place.
 * @param plane - The plane.
 * @param words - How many words are meaningful.
 * @returns How many slots survive.
 */
export function andDense(
  accumulator: Uint32Array,
  plane: Uint32Array,
  words: number,
): number {
  let count = 0;
  for (let word = 0; word < words; word++) {
    const value = (accumulator[word] as number) & (plane[word] as number);
    accumulator[word] = value;
    if (value !== 0) count += bitCount(value);
  }
  return count;
}

/**
 * AND a plane into the accumulator over the live words only, dropping the
 * ones that empty.
 * @param accumulator - The running intersection, changed in place.
 * @param plane - The plane.
 * @param live - The live words, compacted in place.
 * @param liveCount - How many of them there are.
 * @returns The new number of live words, and how many slots survive.
 */
export function andSparse(
  accumulator: Uint32Array,
  plane: Uint32Array,
  live: Int32Array,
  liveCount: number,
): [number, number] {
  let kept = 0;
  let count = 0;
  for (let index = 0; index < liveCount; index++) {
    const word = live[index] as number;
    // A plane shorter than the accumulator holds no slot past its end.
    const value = (accumulator[word] as number) & (plane[word] ?? 0);
    accumulator[word] = value;
    if (value !== 0) {
      live[kept++] = word;
      count += bitCount(value);
    }
  }
  return [kept, count];
}

/**
 * List the words of the accumulator that hold a survivor.
 * @param accumulator - The running intersection.
 * @param words - How many words are meaningful.
 * @param live - Where to write the word indices.
 * @returns How many there are.
 */
export function listLiveWords(
  accumulator: Uint32Array,
  words: number,
  live: Int32Array,
): number {
  let count = 0;
  for (let word = 0; word < words; word++) {
    if (accumulator[word] !== 0) live[count++] = word;
  }
  return count;
}

/**
 * The surviving slots, as absolute slot numbers.
 * @param accumulator - The running intersection.
 * @param live - The live words, or null to look at every word.
 * @param words - How many words are meaningful.
 * @param base - The chunk's first slot.
 * @param count - How many slots survive.
 * @returns The slots, ascending.
 */
export function slotsOf(
  accumulator: Uint32Array,
  live: Int32Array | null,
  words: number,
  base: number,
  count: number,
): Uint32Array {
  const slots = new Uint32Array(count);
  let next = 0;
  const total = live === null ? words : live.length;
  for (let index = 0; index < total; index++) {
    const word = live === null ? index : (live[index] as number);
    let value = accumulator[word] as number;
    while (value !== 0) {
      const lowest = value & -value;
      const bit = 31 - Math.clz32(lowest);
      // A plane is a byte array, slot `8b + i` in bit i of byte b, so on a
      // big-endian machine the word's high byte holds the lowest slots.
      const offset = LITTLE_ENDIAN ? bit : ((3 - (bit >> 3)) << 3) | (bit & 7);
      slots[next++] = base + word * 32 + offset;
      value ^= lowest;
    }
  }
  return slots;
}

/**
 * Count the set bits of the first words of a buffer.
 * @param words - The buffer.
 * @param length - How many words to count.
 * @returns The number of set bits.
 */
export function countWords(words: Uint32Array, length: number): number {
  let count = 0;
  for (let word = 0; word < length; word++) {
    const value = words[word] as number;
    if (value !== 0) count += bitCount(value);
  }
  return count;
}
