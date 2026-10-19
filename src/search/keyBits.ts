import { PLANES } from '../chemistry/tile.ts';

import type { KeyBits } from './pages.ts';

/** Key bits per list at most. */
export const MAX_LIST_BITS = 256;

/** A search's key bits, checked, as the planes that hold them: bit b is plane `b ^ 31`. */
export interface KeyPlanes {
  /** Planes an answered row holds, every one. */
  all: Int32Array;
  /** Planes of which an answered row holds at least one; empty for no condition. */
  any: Int32Array;
  /** Planes an answered row holds none of. */
  none: Int32Array;
}

/**
 * Checks a search's key bits and gives their planes. A one-bit `any` is a bit the row holds.
 * @param bits - The key bits, as the search gave them.
 * @returns Their planes, each list without repeats.
 * @throws {RangeError} When a bit is not a whole number from 0 to 1535, or a list holds more than
 * 256 bits.
 */
export function readKeyBits(bits: KeyBits | undefined): KeyPlanes {
  const all = planesOf(bits?.all);
  const any = planesOf(bits?.any);
  if (any.length === 1) {
    return {
      all: union(all, any),
      any: new Int32Array(0),
      none: planesOf(bits?.none),
    };
  }
  return { all, any, none: planesOf(bits?.none) };
}

/**
 * The plane of a key bit, checked.
 * @param bit - The key bit.
 * @returns Its plane.
 * @throws {RangeError} When it is not a whole number from 0 to 1535.
 */
export function keyPlane(bit: unknown): number {
  if (
    !Number.isInteger(bit) ||
    (bit as number) < 0 ||
    (bit as number) >= PLANES
  ) {
    throw new RangeError(
      `a key bit is a whole number from 0 to ${PLANES - 1}, not ${String(bit)}`,
    );
  }
  return (bit as number) ^ 31;
}

function planesOf(list: readonly number[] | undefined): Int32Array {
  if (list === undefined) return new Int32Array(0);
  if (!Array.isArray(list)) {
    throw new RangeError('a list of key bits is an array of numbers');
  }
  if (list.length > MAX_LIST_BITS) {
    throw new RangeError(`at most ${MAX_LIST_BITS} key bits per list`);
  }
  const planes = new Set<number>();
  for (const bit of list) planes.add(keyPlane(bit));
  return Int32Array.from(planes);
}

function union(a: Int32Array, b: Int32Array): Int32Array {
  const planes = new Set<number>(a);
  for (const plane of b) planes.add(plane);
  return Int32Array.from(planes);
}
