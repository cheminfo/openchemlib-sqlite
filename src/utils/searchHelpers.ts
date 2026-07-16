import type * as OpenChemLib from 'openchemlib';

import type { InputFormat, SearchResult } from '../types.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

/**
 * Parse a molecule string according to the given format.
 *
 * `ensureCoordinates` only affects the `idCode` format, where inventing 2D
 * coordinates costs roughly 20x the parse itself. They are needed **only** to
 * re-encode the molecule back to a canonical idCode (`getIDCode()`): without
 * them OCL drops the stereo descriptors, so the re-encoded idCode differs from
 * the original for every stereo-bearing molecule. Everything that reads the
 * graph instead — the fingerprint (`getIndex()`), the molecular formula, and
 * substructure matching — is coordinate-independent and must pass `false`.
 * @param Molecule - OCL Molecule class.
 * @param str - Input string.
 * @param format - Input format.
 * @param ensureCoordinates - Whether to invent 2D coordinates for an idCode.
 *   Pass true only when the result will be re-encoded with `getIDCode()`.
 * @returns Parsed OCL Molecule.
 */
export function parseMolecule(
  Molecule: OCLLibrary['Molecule'],
  str: string,
  format: InputFormat,
  ensureCoordinates: boolean,
): OCLMolecule {
  switch (format) {
    case 'smiles':
      return Molecule.fromSmiles(str);
    case 'molfile':
      return Molecule.fromMolfile(str);
    case 'idCode':
      return Molecule.fromIDCode(str, ensureCoordinates);
    default:
      throw new Error(`Unknown format: ${String(format)}`);
  }
}

/**
 * Convert a DB row from the entries + ocl_ss_index join into a SearchResult.
 * Includes the mw field when the row contains a mw column.
 * @param row - Raw DB row.
 * @returns SearchResult.
 */
export function rowToResult(row: Record<string, unknown>): SearchResult {
  const result: SearchResult = {
    // Number() is required because setReadBigInts(true) — used on fingerprint
    // scan statements to avoid precision loss on 64-bit ss_index columns —
    // also makes entry_id return as BigInt even though it is a safe integer.
    entryId: Number(row.entry_id),
    idCode: row.id_code as string,
  };
  if (row.mw != null) result.mw = row.mw as number;
  return result;
}
