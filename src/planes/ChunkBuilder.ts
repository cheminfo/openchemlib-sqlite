import {
  SLOTS_PER_CHUNK,
  bytesForSlots,
  countBits,
  setBit,
} from './planeLayout.ts';

/**
 * One chunk of the plane index, built in memory before it is written.
 *
 * A fold writes whole chunks and never reads one back to extend it, so this
 * holds the planes of exactly one chunk and is reset between them. Only the
 * bits some molecule in the chunk actually sets get a buffer, so a chunk of
 * rare bits costs a fraction of the 64 MB a dense chunk of all 512 would.
 */
export class ChunkBuilder {
  readonly #planes = new Map<number, Uint8Array>();
  #used = 0;

  /**
   * How many slots of this chunk are filled.
   * @returns The number of slots taken.
   */
  get used(): number {
    return this.#used;
  }

  /**
   * Whether the chunk has no room left.
   * @returns True when every slot is taken.
   */
  get full(): boolean {
    return this.#used >= SLOTS_PER_CHUNK;
  }

  /**
   * Take the next slot of this chunk for a molecule's fingerprint.
   * @param bits - The bit positions the fingerprint sets.
   * @returns The slot's offset within the chunk.
   * @throws {RangeError} When the chunk is already full.
   */
  add(bits: readonly number[]): number {
    if (this.full) throw new RangeError('the chunk is full');
    const offset = this.#used++;
    for (const bit of bits) {
      let plane = this.#planes.get(bit);
      if (plane === undefined) {
        plane = new Uint8Array(bytesForSlots(SLOTS_PER_CHUNK));
        this.#planes.set(bit, plane);
      }
      setBit(plane, offset);
    }
    return offset;
  }

  /**
   * How many of this chunk's molecules set each bit.
   *
   * Read before the chunk is written, because the first chunk of the first fold
   * is what decides which bits are worth storing at all.
   * @returns The population of every bit the chunk sets, by bit position.
   */
  populations(): Map<number, number> {
    const counts = new Map<number, number>();
    const length = bytesForSlots(this.#used);
    for (const [bit, plane] of this.#planes) {
      counts.set(bit, countBits(plane, length));
    }
    return counts;
  }

  /**
   * The planes to write for this chunk, trimmed to the slots in use.
   *
   * A bit the chunk never sets is absent, which is exactly how the reader
   * interprets a missing row, so nothing has to be written to say so.
   * @param stored - The bits the index keeps planes for; others are skipped.
   * @yields {[number, Uint8Array]} Each bit and the blob to store for it.
   */
  *entries(stored: ReadonlySet<number>): Generator<[number, Uint8Array]> {
    const length = bytesForSlots(this.#used);
    for (const [bit, plane] of this.#planes) {
      if (!stored.has(bit)) continue;
      yield [bit, plane.subarray(0, length)];
    }
  }

  /** Forget everything, ready for the next chunk. */
  reset(): void {
    this.#planes.clear();
    this.#used = 0;
  }
}
