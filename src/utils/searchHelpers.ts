import type * as OpenChemLib from 'openchemlib';

import type { InputFormat, ScanPosition, SearchResult } from '../types.ts';

import type { PrescreenState } from './prescreen.ts';

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
 * Order matches lightest first, and matches of one weight by entry id: the
 * order the prescreen streams them in.
 *
 * Isomers share a weight, and the verifier pool hands batches back in whatever
 * order they finish, so ordered by weight alone the same search could order —
 * and cut at `maxResults` — the same matches differently from run to run, and
 * one page could repeat a match the previous one showed.
 * @param a - One match.
 * @param b - The other.
 * @returns Negative when `a` comes first.
 */
export function byWeight(a: SearchResult, b: SearchResult): number {
  return (a.mw ?? 0) - (b.mw ?? 0) || a.entryId - b.entryId;
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

/**
 * A position before every entry, for a scan that ran out of time before it
 * read one: finite, so it survives being written into JSON.
 */
export const BEFORE_EVERY_ENTRY: ScanPosition = {
  mw: -Number.MAX_VALUE,
  entryId: Number.MIN_SAFE_INTEGER,
};

/**
 * Where a substructure scan that stopped early resumes.
 *
 * Stopped at `maxResults`, it resumes after the last match it kept: every
 * candidate before that one was verified, so nothing is skipped and nothing is
 * answered twice. Out of time short of that, it resumes after the last
 * candidate it read, or where it started when it read none. The plane index
 * reads in slot order, so a scan it answered has no position to resume from.
 * @param kept - The matches kept, in `(mw, entry_id)` order.
 * @param maxResults - The most matches the scan was to keep.
 * @param state - How the prescreen ended.
 * @param lastRead - The last candidate the prescreen yielded, if any.
 * @param after - Where the scan started, if not at the first candidate.
 * @returns The position, or undefined when the scan read every candidate.
 */
export function resumePosition(
  kept: readonly SearchResult[],
  maxResults: number,
  state: PrescreenState,
  lastRead: SearchResult | undefined,
  after: ScanPosition | undefined,
): ScanPosition | undefined {
  if (!state.partial || state.usedPlaneIndex) return undefined;
  const last = kept.length >= maxResults ? kept.at(-1) : lastRead;
  if (last === undefined) return after ?? BEFORE_EVERY_ENTRY;
  return { mw: last.mw ?? 0, entryId: last.entryId };
}
