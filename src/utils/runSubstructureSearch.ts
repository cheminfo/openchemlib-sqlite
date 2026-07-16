import type * as OpenChemLib from 'openchemlib';

import type {
  SQLiteDatabase,
  SearchCandidates,
  SearchResponse,
  SearchResult,
} from '../types.ts';

import { createVerifier } from './createVerifier.ts';
import type { PrescreenState } from './prescreen.ts';
import { prescreen } from './prescreen.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

export interface SubstructureSearchParams {
  db: SQLiteDatabase;
  ocl: OCLLibrary;
  entriesTable: string;
  /** Primary-key column of the entries table. */
  pkColumn: string;
  /** idCode column of the entries table. */
  idCodeColumn: string;
  /** Fragment flag must already be set to true before passing. */
  mol: OCLMolecule;
  from: number;
  limit: number;
  timeoutMs: number;
  maxCandidates: number;
  maxResults: number;
  onProgress?: (processed: number, total: number) => void;
  /** Restrict the scan to the entries returned by this subquery. */
  candidates?: SearchCandidates;
}

/**
 * Run a substructure search on the calling thread.
 *
 * Used when no verifier pool is available (poolSize 1) or when the candidate set
 * is too small to be worth a round trip to one. It runs the same two steps as the
 * pooled path — the shared {@link prescreen} stream, then a plain `SSSearcher`
 * per candidate — so both paths return identical results.
 *
 * Candidates arrive lightest-first (the index is clustered by molecular weight),
 * so stopping at `maxResults` keeps the smallest superstructures: the matches
 * closest to the query.
 * @param params - Search parameters; params.mol.fragment must already be set to true.
 * @returns Search response, including `screened`, `matched`, and `elapsedMs`.
 */
export function runSubstructureSearch(
  params: SubstructureSearchParams,
): SearchResponse {
  const { ocl, mol, from, limit, maxResults } = params;
  const start = Date.now();
  const state: PrescreenState = { screened: 0, partial: false };
  const results: SearchResult[] = [];

  const verify = createVerifier(ocl, mol);
  for (const candidate of prescreen(params, state)) {
    if (verify(candidate.idCode)) {
      results.push({
        entryId: candidate.entryId,
        idCode: candidate.idCode,
        mw: candidate.mw,
      });
      if (results.length >= maxResults) {
        state.partial = true;
        break;
      }
    }
  }
  params.onProgress?.(state.screened, state.screened);

  return {
    results: results.slice(from, from + limit),
    total: results.length,
    screened: state.screened,
    matched: results.length,
    elapsedMs: Date.now() - start,
    partial: state.partial,
  };
}
