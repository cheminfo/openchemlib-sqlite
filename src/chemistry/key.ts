/** The id span of one atom count: id = atomCount·2^36 + seq. */
export const SEQ_SPAN = 2 ** 36;

/**
 * The largest atom count a key holds. A larger molecule is clamped, which keeps a query's floor at
 * or below the key of every molecule it can match, since the floor is clamped the same way.
 */
export const MAX_ATOMS = 65_535;

/** The largest seq a tile slot holds (a Uint32). */
export const MAX_SEQ = 2 ** 32 - 1;

/**
 * An atom count as the key stores it.
 * @param atoms - The count.
 * @returns The count, at most {@link MAX_ATOMS}.
 */
export function clampAtoms(atoms: number): number {
  return Math.min(atoms, MAX_ATOMS);
}

/**
 * The id of a molecule: its atom count in the high part, its arrival number in the low 36 bits.
 * Every id stays below 2^53, so a JavaScript number holds it exactly.
 * @param atoms - Its atom count, explicit hydrogens included.
 * @param seq - Its arrival number, from 1, never reused.
 * @returns atomCount·2^36 + seq.
 */
export function makeId(atoms: number, seq: number): number {
  return clampAtoms(atoms) * SEQ_SPAN + seq;
}

/**
 * The atom count an id holds.
 * @param id - The id.
 * @returns Its high part.
 */
export function atomCountOf(id: number): number {
  return Math.floor(id / SEQ_SPAN);
}

/**
 * The seq an id holds.
 * @param id - The id.
 * @returns Its low 36 bits.
 */
export function seqOf(id: number): number {
  return id - Math.floor(id / SEQ_SPAN) * SEQ_SPAN;
}
