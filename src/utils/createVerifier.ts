import { SubstructureResult, ssSearch } from 'openchemlib-wasm';

/**
 * Test a batch of prescreened candidates against a fragment — step 2 of a
 * substructure search, and ~97% of its cost.
 *
 * The matching runs in `openchemlib-wasm`: OpenChemLib compiled to WebAssembly, which does exactly
 * this work — parse an idCode, match a fragment against the graph — at about twice the speed of the
 * JavaScript build. It takes the whole batch in one call, so the query fragment is parsed once for
 * the batch rather than once per candidate.
 *
 * The query crosses as an idCode, so it is only what `getIDCode` can encode. A bond query feature
 * that excludes a single bond does not survive that: a bond drawn "double or aromatic" comes back
 * delocalized, and the query then matches a different set than the `Molecule` itself would. The
 * verifier pool has always sent the query as an idCode, so this is the answer the default path
 * already gave — it is now the answer every path gives.
 *
 * An empty fragment is contained in every molecule, so it short-circuits without parsing anything.
 * @param fragment - The query fragment, as an idCode. It is matched as a fragment whatever its own
 * fragment flag says.
 * @param idCodes - The candidates to test.
 * @param emptyFragment - True when the query has no atoms, so every candidate matches.
 * @returns The positions within `idCodes` that contain the fragment, in order.
 */
export function verifyIdCodes(
  fragment: string,
  idCodes: string[],
  emptyFragment = false,
): number[] {
  if (emptyFragment) return idCodes.map((_, index) => index);
  const result = new Uint8Array(idCodes.length);
  ssSearch(fragment, idCodes, result);
  const matches: number[] = [];
  for (let i = 0; i < idCodes.length; i++) {
    if (result[i] === SubstructureResult.match) matches.push(i);
  }
  return matches;
}
