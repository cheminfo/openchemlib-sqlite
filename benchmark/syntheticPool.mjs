// Real molecules for a synthetic library: ~8700 combinatorial SMILES, each with its fingerprint,
// weight and idCode, computed once and cached. Sampled with replacement, they give a library of
// any size whose bit marginals AND bit correlations are those of real structures — a fingerprint
// drawn bit by bit is independent, which makes every multi-bit query return nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import * as OCL from 'openchemlib';

const POOL_CACHE = '/tmp/planeScan-pool.json';

const SUBS = ['', 'C', 'CC', 'O', 'OC', 'N', 'NC', 'F', 'Cl', 'Br', 'C(=O)O',
  'C(=O)N', 'S(=O)(=O)N', 'C#N', 'CO', 'CCO', 'C(F)(F)F'];
const RINGS = ['c1ccccc1', 'c1ccncc1', 'c1ccc2ccccc2c1', 'C1CCCCC1',
  'c1cc[nH]c1', 'c1ccsc1', 'C1CCNCC1', 'c1ncccn1'];
const LINKS = ['', 'C', 'CC', 'O', 'NC(=O)', 'C(=O)N', 'S', 'CCO'];

/**
 * The pool, from the cache when it is there.
 * @returns Entries of `{ index, mw, idCode }`, `index` as `Molecule.getIndex()` returns it.
 */
export function syntheticPool() {
  if (existsSync(POOL_CACHE)) {
    return JSON.parse(readFileSync(POOL_CACHE, 'utf8'));
  }
  const entries = [];
  for (const sub of SUBS) {
    for (const a of RINGS) {
      for (const link of LINKS) {
        for (const b of RINGS) {
          if (a === b && link === '') continue;
          try {
            const mol = OCL.Molecule.fromSmiles(`${sub}${a}${link}${b}`);
            if (mol.getAllAtoms() === 0) continue;
            entries.push({
              index: [...mol.getIndex()],
              mw: mol.getMolecularFormula().relativeWeight,
              idCode: mol.getIDCode(),
            });
          } catch {
            /* an unparseable combination is simply skipped */
          }
        }
      }
    }
  }
  writeFileSync(POOL_CACHE, JSON.stringify(entries));
  return entries;
}
