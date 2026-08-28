import { substructureSearch } from 'openchemlib-search-wasm';

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
 * **The wire carries idCodes and positions, not the candidate objects.**
 * `substructureSearch` hands back the entries themselves, which is what the
 * calling thread uses directly — but a worker has to structured-clone whatever
 * crosses, and cloning 256 three-property objects each way measures 0.5758 µs
 * per candidate against 0.0507 µs for the strings out and the positions back
 * (11.4x, 2.0% of a ~26 µs verification). The caller already holds the batch, so
 * it maps the positions back for free. `indexes` on the result is exactly this
 * case.
 *
 * The batch goes to `openchemlib-search-wasm` in a single call, so the fragment
 * is parsed once per batch rather than once per candidate, which is what the
 * per-worker searcher cache used to save.
 * @param task - The fragment and the batch of candidate idCodes.
 * @returns The positions within the batch that contain the fragment.
 */
export function verifyBatch(task: VerifyTask): VerifyResult {
  return { matches: substructureSearch(task.fragment, task.idCodes).indexes };
}
