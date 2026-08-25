import type * as OpenChemLib from 'openchemlib';

import type {
  SQLiteDatabase,
  SearchCandidates,
  SearchResponse,
  SearchResult,
} from '../types.ts';

import { verifyIdCodes } from './createVerifier.ts';
import type { PrescreenState } from './prescreen.ts';
import { prescreen } from './prescreen.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

/**
 * The most candidates verified per WebAssembly call.
 *
 * A batch is only worth having because the fragment is then parsed once for it rather than once per
 * candidate; past a couple of hundred candidates that cost (~12 µs) has already vanished, so a
 * bigger batch buys nothing and only risks pulling more of the stream than the scan needs.
 */
const MAX_VERIFY_BATCH = 256;

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
 * pooled path — the shared {@link prescreen} stream, then `openchemlib-search-wasm` over each batch of
 * candidates — so both paths return identical results.
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
  const { mol, from, limit, maxResults } = params;
  const start = Date.now();
  const state: PrescreenState = { screened: 0, partial: false };
  const results: SearchResult[] = [];
  const emptyFragment = mol.getAllAtoms() === 0;
  const fragment = emptyFragment ? '' : mol.getIDCode();

  // The verifier takes batches, so candidates are buffered as the prescreen yields them and tested
  // a batch at a time. Matches are pushed in prescreen order, so the lightest-first guarantee — and
  // therefore which matches survive `maxResults` — is exactly what it was one candidate at a time.
  const batch: SearchResult[] = [];
  const idCodes: string[] = [];
  let stop = false;

  // Never pull more candidates than the scan could still need. Even if every one of them matched,
  // `maxResults - results.length` is enough, so anything beyond that is guaranteed waste — and
  // pulling it would defeat the streaming prescreen, whose whole point is that a search for three
  // results reads three rows and stops.
  const nextBatchSize = () =>
    Math.max(1, Math.min(MAX_VERIFY_BATCH, maxResults - results.length));

  const flush = () => {
    if (idCodes.length === 0) return;
    for (const index of verifyIdCodes(fragment, idCodes, emptyFragment)) {
      results.push(batch[index] as SearchResult);
      if (results.length >= maxResults) {
        state.partial = true;
        stop = true;
        break;
      }
    }
    batch.length = 0;
    idCodes.length = 0;
  };

  for (const candidate of prescreen(params, state)) {
    batch.push({
      entryId: candidate.entryId,
      idCode: candidate.idCode,
      mw: candidate.mw,
    });
    idCodes.push(candidate.idCode);
    if (idCodes.length >= nextBatchSize()) {
      flush();
      if (stop) break;
    }
  }
  if (!stop) flush();
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
