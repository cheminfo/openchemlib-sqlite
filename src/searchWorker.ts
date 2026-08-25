import { verifyIdCodes } from './utils/createVerifier.ts';

/** One batch of prescreened candidates, sent to a verifier worker. */
export interface VerifyTask {
  /** Specifier the worker re-imports this module from (set by the pool). */
  workerModule: string;
  /** The query fragment as an OCL idCode: cheap to transfer, parsed once per batch. */
  fragment: string;
  /** idCodes of the candidates to test, in prescreen (ascending mw) order. */
  idCodes: string[];
}

/** Which candidates of a batch really contain the fragment. */
export interface VerifyResult {
  /** Positions within {@link VerifyTask.idCodes} that matched. */
  matches: number[];
}

/**
 * Verify one batch of prescreened candidates against a fragment.
 *
 * This worker holds no database connection and issues no query: it is a pure
 * match / not-match function over idCodes, which is the ~97% of a substructure
 * search that actually costs anything.
 *
 * The batch goes to `openchemlib-search-wasm` in a single call. There is no per-worker searcher cache any
 * more: the fragment is parsed once per batch rather than once per candidate, which is what the
 * cache used to save. A batch holds at most `batchSize` candidates (128 by default), and a small
 * `maxResults` shrinks it further, so that trade is closest at the small end.
 * @param task - The fragment and the batch of candidate idCodes.
 * @returns The positions within the batch that contain the fragment.
 */
export function verifyBatch(task: VerifyTask): VerifyResult {
  return { matches: verifyIdCodes(task.fragment, task.idCodes) };
}
