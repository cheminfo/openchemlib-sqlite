import { alignRows } from '../blocks.ts';

/** One set's bitmap as the tail holds it. */
export interface TailSet {
  name: string;
  family: string;
  value: unknown;
  buffer: SharedArrayBuffer;
  words: Int32Array;
}

/**
 * The bitmaps over the row space the tail keeps current: the alive rows and every set. A set bit
 * is only ever set on an alive row. They grow, copied, when the row space passes their capacity;
 * a published one is otherwise changed in place, bit by bit.
 */
export class TailBitmaps {
  readonly sets = new Map<string, TailSet>();
  alive: { buffer: SharedArrayBuffer; words: Int32Array };
  capacity: number;
  /** Whether a bitmap was added or grown since the last publish. */
  changed = false;
  readonly #headroomRows: number;
  readonly #headroomShare: number;

  /**
   * The bitmaps of a loaded image.
   * @param alive - The alive bitmap.
   * @param sets - The sets' bitmaps.
   * @param capacity - Rows the bitmaps hold.
   * @param headroom - Rows added when they grow: at least `rows`, or `share` of the row space.
   * @param headroom.rows - The least rows added.
   * @param headroom.share - The share of the row space added.
   */
  constructor(
    alive: SharedArrayBuffer,
    sets: Array<{
      name: string;
      family: string;
      value: unknown;
      bitmap: SharedArrayBuffer;
    }>,
    capacity: number,
    headroom: { rows: number; share: number },
  ) {
    this.alive = { buffer: alive, words: new Int32Array(alive) };
    for (const set of sets) {
      this.sets.set(set.name, {
        ...set,
        buffer: set.bitmap,
        words: new Int32Array(set.bitmap),
      });
    }
    this.capacity = capacity;
    this.#headroomRows = headroom.rows;
    this.#headroomShare = headroom.share;
  }

  /**
   * A set created after the load: an empty bitmap (its members come with the change log).
   * @param name - Its name.
   * @param family - Its family.
   * @param value - Its name within the family.
   */
  addSet(name: string, family: string, value: unknown): void {
    if (this.sets.has(name)) return;
    const buffer = new SharedArrayBuffer(this.capacity / 8);
    this.sets.set(name, {
      name,
      family,
      value,
      buffer,
      words: new Int32Array(buffer),
    });
    this.changed = true;
  }

  /**
   * Grows every bitmap, copied, so it holds `needed` rows.
   * @param needed - The rows the row space reaches.
   */
  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    if (needed >= 2 ** 31) {
      throw new Error(`the row space would pass 2^31 rows (${needed})`);
    }
    const capacity = alignRows(
      Math.min(
        2 ** 31 - 1,
        needed +
          Math.max(this.#headroomRows, Math.ceil(needed * this.#headroomShare)),
      ),
    );
    const grow = (old: Int32Array) => {
      const buffer = new SharedArrayBuffer(capacity / 8);
      const words = new Int32Array(buffer);
      words.set(old);
      return { buffer, words };
    };
    for (const set of this.sets.values()) Object.assign(set, grow(set.words));
    this.alive = grow(this.alive.words);
    this.capacity = capacity;
    this.changed = true;
  }

  /**
   * Whether a row is alive.
   * @param g - The row.
   * @returns True when the columns SQL returns it.
   */
  isAlive(g: number): boolean {
    return ((Atomics.load(this.alive.words, g >>> 5) >>> (g & 31)) & 1) === 1;
  }

  /**
   * Copies a row's bits (alive and every set) to another row.
   * @param from - The row read.
   * @param to - The row written.
   */
  copyRow(from: number, to: number): void {
    const maps = [
      this.alive.words,
      ...[...this.sets.values()].map((set) => set.words),
    ];
    for (const map of maps) {
      if (((Atomics.load(map, from >>> 5) >>> (from & 31)) & 1) !== 0) {
        Atomics.or(map, to >>> 5, 1 << (to & 31));
      }
    }
  }

  /**
   * Sets or clears one bit.
   * @param words - The bitmap.
   * @param g - The row.
   * @param on - The bit's new value.
   * @returns Whether it changed.
   */
  setBit(words: Int32Array, g: number, on: boolean): boolean {
    const bit = 1 << (g & 31);
    if (((Atomics.load(words, g >>> 5) & bit) !== 0) === on) return false;
    if (on) Atomics.or(words, g >>> 5, bit);
    else Atomics.and(words, g >>> 5, ~bit);
    return true;
  }

  /**
   * Clears a row in every bitmap: it is dead.
   * @param g - The row.
   */
  clearRow(g: number): void {
    this.setBit(this.alive.words, g, false);
    for (const set of this.sets.values()) this.setBit(set.words, g, false);
  }
}
