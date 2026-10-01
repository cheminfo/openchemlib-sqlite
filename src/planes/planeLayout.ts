/**
 * How many bits OpenChemLib's `Molecule.getIndex()` fingerprint holds.
 *
 * It returns 16 unsigned 32-bit words, which is what `ocl_ss_index` stores as
 * eight 64-bit columns and what a plane index transposes.
 */
export const PLANE_BITS = 512;

/**
 * Slots covered by one chunk of one plane: 2^20 molecules, so a full chunk is a
 * 128 KB blob.
 *
 * It is the unit everything else is sized by, and 128 KB was measured as the
 * point where SQLite hands blobs back at full speed (~1 GB/s) while still being
 * small enough that a scan can abandon a chunk early. A fold only ever writes
 * whole chunks, so nothing is ever read back and rewritten.
 */
export const SLOTS_PER_CHUNK = 1 << 20;

/** Bytes in a full chunk of one plane. */
export const CHUNK_BYTES = SLOTS_PER_CHUNK / 8;

/**
 * Which chunk a slot falls in.
 * @param slot - The slot number.
 * @returns The chunk index.
 */
export function chunkOfSlot(slot: number): number {
  return Math.floor(slot / SLOTS_PER_CHUNK);
}

/**
 * Where a slot sits inside its chunk.
 * @param slot - The slot number.
 * @returns The slot's offset within its chunk.
 */
export function offsetInChunk(slot: number): number {
  return slot % SLOTS_PER_CHUNK;
}

/**
 * Bytes needed to hold a given number of slots.
 * @param slots - How many slots the blob must cover.
 * @returns The blob length in bytes.
 */
export function bytesForSlots(slots: number): number {
  return Math.ceil(slots / 8);
}

/**
 * Read one bit out of a plane blob.
 * @param bits - The plane blob.
 * @param offset - The slot's offset within the chunk.
 * @returns Whether the bit is set.
 */
export function readBit(bits: Uint8Array, offset: number): boolean {
  const byte = bits[offset >> 3];
  if (byte === undefined) return false;
  return (byte & (1 << (offset & 7))) !== 0;
}

/**
 * Set one bit in a plane blob.
 * @param bits - The plane blob, long enough to hold the offset.
 * @param offset - The slot's offset within the chunk.
 */
export function setBit(bits: Uint8Array, offset: number): void {
  const index = offset >> 3;
  const byte = bits[index];
  if (byte === undefined) return;
  bits[index] = byte | (1 << (offset & 7));
}

/**
 * Unpack an OpenChemLib fingerprint into the bit positions it sets.
 *
 * The positions are what a plane index is keyed by, so this is the one place
 * that fixes the bit numbering: word `w` of `getIndex()` owns bits
 * `32w .. 32w+31`, least significant first.
 * @param index - The fingerprint as `Molecule.getIndex()` returns it.
 * @returns The bit positions that are set, ascending.
 */
export function bitsOfIndex(index: number[] | Uint32Array): number[] {
  const positions: number[] = [];
  for (let word = 0; word < index.length; word++) {
    const value = index[word] ?? 0;
    if (value === 0) continue;
    for (let bit = 0; bit < 32; bit++) {
      if ((value & (1 << bit)) !== 0) positions.push(word * 32 + bit);
    }
  }
  return positions;
}

/**
 * Count the set bits of a plane blob, reading it 32 bits at a time.
 *
 * Used to report how many candidates a plane intersection left, which is what
 * decides whether the intersection is worth verifying at all.
 * @param bits - The blob to count.
 * @param length - How many bytes of it are meaningful.
 * @returns The number of set bits.
 */
export function countBits(bits: Uint8Array, length = bits.length): number {
  let total = 0;
  // A blob handed back by SQLite carries whatever byte offset its row had, and
  // a Uint32Array view needs a multiple of four, so the word loop is only
  // available when it happens to be aligned.
  const aligned = bits.byteOffset % 4 === 0;
  const wordCount = aligned ? Math.floor(length / 4) : 0;
  const words = aligned
    ? new Uint32Array(bits.buffer, bits.byteOffset, wordCount)
    : new Uint32Array(0);
  for (let index = 0; index < wordCount; index++) {
    let x = words[index] ?? 0;
    x -= (x >> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    total += (x * 0x01010101) >> 24;
  }
  for (let byte = wordCount * 4; byte < length; byte++) {
    let x = bits[byte] ?? 0;
    while (x !== 0) {
      x &= x - 1;
      total++;
    }
  }
  return total;
}
