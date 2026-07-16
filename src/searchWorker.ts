import * as OCL from 'openchemlib';

type OCLSearcher = InstanceType<typeof OCL.SSSearcher>;

/** One batch of prescreened candidates, sent to a verifier worker. */
export interface VerifyTask {
  /** Specifier the worker re-imports this module from (set by the pool). */
  workerModule: string;
  /** The query fragment as an OCL idCode: cheap to transfer, parsed once per worker. */
  fragment: string;
  /** idCodes of the candidates to test, in prescreen (ascending mw) order. */
  idCodes: string[];
}

/** Which candidates of a batch really contain the fragment. */
export interface VerifyResult {
  /** Positions within {@link VerifyTask.idCodes} that matched. */
  matches: number[];
}

// One searcher per fragment, kept for the worker's whole life. A worker that has
// already seen a fragment answers every later batch without re-parsing it, so
// the fragment is effectively sent once however many batches follow.
const searchers = new Map<string, OCLSearcher>();

// A server can be asked for many different fragments; keep the cache from
// growing without bound. Fragments are tiny, so a generous cap is still cheap.
const MAX_CACHED_FRAGMENTS = 64;

function getSearcher(fragment: string): OCLSearcher {
  const cached = searchers.get(fragment);
  if (cached) return cached;
  if (searchers.size >= MAX_CACHED_FRAGMENTS) searchers.clear();
  // `false` skips 2D-coordinate invention: it costs ~20x the parse itself and
  // substructure matching only ever needs the atom/bond graph.
  const mol = OCL.Molecule.fromIDCode(fragment, false);
  mol.setFragment(true);
  // Plain SSSearcher, not SSSearcherWithIndex: the SQL prescreen already applied
  // the fingerprint bitmask, so re-testing it here would be duplicated work (and
  // would force every target's fingerprint over the thread boundary).
  const searcher = new OCL.SSSearcher();
  searcher.setFragment(mol);
  searchers.set(fragment, searcher);
  return searcher;
}

/**
 * Verify one batch of prescreened candidates against a fragment.
 *
 * This worker holds no database connection and issues no query: it is a pure
 * match / not-match function over idCodes, which is the ~97% of a substructure
 * search that actually costs anything.
 * @param task - The fragment and the batch of candidate idCodes.
 * @returns The positions within the batch that contain the fragment.
 */
export function verifyBatch(task: VerifyTask): VerifyResult {
  const searcher = getSearcher(task.fragment);
  const { idCodes } = task;
  const matches: number[] = [];
  for (let i = 0; i < idCodes.length; i++) {
    searcher.setMolecule(OCL.Molecule.fromIDCode(idCodes[i] as string, false));
    if (searcher.isFragmentInMolecule()) matches.push(i);
  }
  return { matches };
}
