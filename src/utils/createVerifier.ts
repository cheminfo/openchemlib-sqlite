import type * as OpenChemLib from 'openchemlib';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

/**
 * Build a match / not-match function for one fragment — step 2 of a substructure
 * search, and ~97% of its cost. This is the same work a verifier worker does,
 * run on the calling thread instead; both paths must agree exactly.
 *
 * An empty fragment is contained in every molecule, so it short-circuits without
 * parsing anything.
 * @param ocl - OpenChemLib namespace.
 * @param mol - The query fragment (its fragment flag must already be true).
 * @returns A predicate taking a candidate idCode.
 */
export function createVerifier(
  ocl: OCLLibrary,
  mol: OCLMolecule,
): (idCode: string) => boolean {
  if (mol.getAllAtoms() === 0) return () => true;
  const { Molecule, SSSearcher } = ocl;
  // Plain SSSearcher, not SSSearcherWithIndex: the prescreen already applied the
  // fingerprint bitmask in SQL, so the indexed variant would only repeat that
  // test — and would force every candidate's fingerprint to be read and carried.
  const searcher = new SSSearcher();
  searcher.setFragment(mol);
  return (idCode: string) => {
    // `false` skips 2D-coordinate invention: it is ~20x the cost of the parse
    // and a graph match never looks at coordinates.
    searcher.setMolecule(Molecule.fromIDCode(idCode, false));
    return searcher.isFragmentInMolecule();
  };
}
