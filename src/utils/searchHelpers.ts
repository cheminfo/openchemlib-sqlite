import type * as OpenChemLib from 'openchemlib';

import type { InputFormat, SearchResult } from '../types.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

/**
 * Parse a molecule string according to the given format.
 * @param Molecule - OCL Molecule class.
 * @param str - Input string.
 * @param format - Input format.
 * @returns Parsed OCL Molecule.
 */
export function parseMolecule(
  Molecule: OCLLibrary['Molecule'],
  str: string,
  format: InputFormat,
): OCLMolecule {
  switch (format) {
    case 'smiles':
      return Molecule.fromSmiles(str);
    case 'molfile':
      return Molecule.fromMolfile(str);
    case 'idCode':
      return Molecule.fromIDCode(str);
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
