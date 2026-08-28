// Does `openchemlib-search-wasm` answer exactly what `openchemlib` answers?
//
// Both halves of the search are checked against a real library of molecules:
//
//   1. the fingerprint  — wasm `getIndex` vs OCL `Molecule.getIndex()`, word for word
//   2. the verification — wasm `substructureSearch` vs an OCL `SSSearcher` loop,
//      over every molecule, for every query
//
// A single differing word or position is reported with the idcode that produced it, so a
// disagreement can be reproduced on its own.
//
// Usage:
//   node --experimental-strip-types benchmark/wasmParity.mjs <idcodes.txt> [count] [fingerprintCount]
//
// The file holds one idcode per line. See benchmark/README.md for where to get one.
// `openchemlib`'s own fingerprint costs ~4.5 ms per molecule, so the fingerprint half is capped
// separately (25 000 by default) while the verification half runs over everything.
import { readFileSync } from 'node:fs';

import * as OCL from 'openchemlib';
import { getIndex, substructureSearch } from 'openchemlib-search-wasm';

const FILE = process.argv[2];
const COUNT = process.argv[3] ? Number(process.argv[3]) : Infinity;
const FINGERPRINT_COUNT = process.argv[4] ? Number(process.argv[4]) : 25_000;
// ONLY=benzene,phenol re-checks a few queries without paying for the whole set again.
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
if (!FILE) {
  throw new Error('usage: wasmParity.mjs <idcodes.txt> [count]');
}

// A spread of query shapes rather than a spread of sizes: what could diverge between the two
// builds is how a feature is interpreted, so each query carries a different one — aromaticity,
// a heteroatom in a ring, a charge, an explicit hydrogen count, a stereo bond, a chain.
const QUERIES = [
  ['benzene', 'c1ccccc1'],
  ['pyridine', 'c1ccncc1'],
  ['amide', 'CC(=O)N'],
  ['carboxylate', 'CC(=O)[O-]'],
  ['ammonium', 'C[NH3+]'],
  ['phenol', 'Oc1ccccc1'],
  ['aniline', 'Nc1ccccc1'],
  ['nitro', 'C[N+](=O)[O-]'],
  ['sulfonamide', 'CS(=O)(=O)N'],
  ['phosphate', 'COP(=O)(O)O'],
  ['ribose', 'OCC1OC(O)C(O)C1O'],
  ['indole', 'c1ccc2[nH]ccc2c1'],
  ['purine', 'c1ncc2[nH]cnc2n1'],
  ['steroid', 'C1CC2CCC3C(CCC4CCCCC34)C2C1'],
  ['phenazine', 'c1ccc2nc3ccccc3nc2c1'],
  ['carbazole', 'c1ccc2[nH]c3ccccc3c2c1'],
  ['E-alkene', 'C/C=C/C'],
  ['chiral-alanine', 'C[C@H](N)C(=O)O'],
  ['long-chain', 'CCCCCCCC'],
  ['ether', 'COC'],
  ['thiol', 'CS'],
  ['halide', 'CCl'],
];

const idCodes = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
if (idCodes.length > COUNT) idCodes.length = COUNT;
console.log(`${idCodes.length} molecules from ${FILE}\n`);

let failures = 0;

// --- 1. the fingerprint -----------------------------------------------------
// Every molecule is fingerprinted both ways and compared word by word. A single wrong bit changes
// which candidates a prescreen lets through, so nothing weaker than an exact match will do.
const fingerprintCount = Math.min(idCodes.length, FINGERPRINT_COUNT);
console.log('FINGERPRINT — wasm getIndex vs OCL Molecule.getIndex()');
let indexChecked = 0;
let indexUnparsable = 0;
for (let i = 0; i < fingerprintCount; i++) {
  const idCode = idCodes[i];
  let oclIndex;
  try {
    oclIndex = OCL.Molecule.fromIDCode(idCode, false).getIndex();
  } catch {
    indexUnparsable++;
    continue;
  }
  const wasmIndex = getIndex(idCode);
  indexChecked++;
  for (let word = 0; word < oclIndex.length; word++) {
    if (oclIndex[word] !== wasmIndex[word]) {
      failures++;
      console.log(
        `  MISMATCH ${idCode} word ${word}: ocl=${oclIndex[word]} wasm=${wasmIndex[word]}`,
      );
      break;
    }
  }
}
console.log(
  `  ${indexChecked} fingerprints compared, ${indexUnparsable} unparsable by OCL, ${failures} mismatches\n`,
);

// --- 2. the verification ----------------------------------------------------
// The verifier is what a search spends ~97% of its time in, and it is the only place the two
// builds could disagree about a match. Positions are compared, not counts: two implementations
// finding the same number of different molecules is not agreement.
console.log('VERIFICATION — wasm substructureSearch vs OCL SSSearcher');
console.log('  query               matches   agree');
for (const [name, smiles] of QUERIES) {
  if (ONLY && !ONLY.has(name)) continue;
  const query = OCL.Molecule.fromSmiles(smiles);
  query.setFragment(true);
  const queryIdCode = query.getIDCode();

  // The `openchemlib` reference, kept here rather than imported: the library no longer contains
  // one, and this script exists to check it against something independent of it.
  const searcher = new OCL.SSSearcher();
  searcher.setFragment(query);
  const oclMatches = [];
  for (let i = 0; i < idCodes.length; i++) {
    // `false` skips 2D-coordinate invention: a graph match never looks at coordinates.
    searcher.setMolecule(OCL.Molecule.fromIDCode(idCodes[i], false));
    if (searcher.isFragmentInMolecule()) oclMatches.push(i);
  }

  const wasmMatches = substructureSearch(queryIdCode, idCodes).indexes;

  let agree = oclMatches.length === wasmMatches.length;
  let firstDiff = -1;
  if (agree) {
    for (let i = 0; i < oclMatches.length; i++) {
      if (oclMatches[i] !== wasmMatches[i]) {
        agree = false;
        firstDiff = i;
        break;
      }
    }
  }
  if (!agree) failures++;
  console.log(
    `  ${name.padEnd(18)} ${String(oclMatches.length).padStart(7)}   ${agree ? 'yes' : 'NO'}`,
  );
  if (!agree) {
    const oclSet = new Set(oclMatches);
    const wasmSet = new Set(wasmMatches);
    const onlyOcl = oclMatches.filter((i) => !wasmSet.has(i)).slice(0, 5);
    const onlyWasm = wasmMatches.filter((i) => !oclSet.has(i)).slice(0, 5);
    console.log(`    wasm found ${wasmMatches.length}, first differing position ${firstDiff}`);
    for (const i of onlyOcl) console.log(`    only OCL : ${idCodes[i]}`);
    for (const i of onlyWasm) console.log(`    only wasm: ${idCodes[i]}`);
  }
}

console.log(
  `\n${failures === 0 ? 'IDENTICAL — no disagreement in either half.' : `${failures} DISAGREEMENTS`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
