import type { RecordColumns } from '../chemistry/records.ts';

/** One molecule of a prepared batch: what the library computed, read-only. */
export interface PreparedMolecule {
  /** The idCode as given. */
  readonly input: string;
  /** The canonical idCode the store keeps, `''` when the molecule carries an error. */
  readonly idCode: string;
  /** Its atom count, explicit hydrogens included: the high part of its id. */
  readonly atoms: number;
  /** The hash of its canonical no-stereo idCode. */
  readonly noStereoHash: bigint;
  /** The hash of its no-stereo generic tautomer; its no-stereo hash when truncated. */
  readonly tautomerHash: bigint;
  /** Whether the tautomer enumeration reached the cap. */
  readonly truncated: boolean;
  /** Why the molecule cannot be stored; undefined when it can. */
  readonly error: string | undefined;
}

/** Molecules computed by the library, to pass to `commit()`. */
export interface PreparedBatch {
  /** One entry per molecule, in input order. */
  readonly molecules: readonly PreparedMolecule[];
}

/**
 * A batch from the columns the library computed.
 * @param inputs - The idCodes as given.
 * @param columns - What the library computed from them.
 * @returns The batch.
 */
export function preparedBatch(
  inputs: readonly string[],
  columns: RecordColumns,
): PreparedBatch {
  const molecules = new Array<PreparedMolecule>(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    molecules[i] = Object.freeze({
      input: inputs[i] as string,
      idCode: columns.idCodes[i] as string,
      atoms: columns.atoms[i] as number,
      noStereoHash: columns.noStereoHashes[i] as bigint,
      tautomerHash: columns.tautomerHashes[i] as bigint,
      truncated: columns.truncated[i] === 1,
      error: columns.errors[i] ?? undefined,
    });
  }
  return Object.freeze({ molecules: Object.freeze(molecules) });
}
