# Benchmarks

Toy databases hide everything that matters here: real molecular weights are
heavily skewed, and real fingerprints let very different numbers of candidates
through. These benchmarks therefore run against the **wwPDB Chemical Component
Dictionary** — ~50 000 real ligands.

## Build the database

```sh
curl -O https://files.wwpdb.org/pub/pdb/data/monomers/components.cif.gz
node --experimental-strip-types benchmark/seedCCD.mjs components.cif.gz bench.sqlite
```

Seeding parses and fingerprints every entry, so it takes a few minutes and only
has to be done once.

## Run

```sh
node --experimental-strip-types benchmark/substructureScan.mjs bench.sqlite
```

It reports two things:

- **Scaling** — wall-clock at poolSize 1/2/4/8 for a rare fragment (phenazine),
  which cannot early-stop and so is the only regime where threads can help.
- **Phases** — how the time divides between the prescreen and the verification.

The second number is what justifies the architecture: the prescreen is ~3% of
the scan, so it is left as a single query on one connection and only the
verification is spread over threads.

## Is `openchemlib-search-wasm` the same answer, faster?

OpenChemLib compiled to WebAssembly does the two expensive things this library
does — build a fingerprint, match a fragment against a graph. Three scripts ask
whether it can replace `openchemlib` here: two check that it answers *exactly*
the same, one measures what that costs.

Any list of idcodes, one per line, works as the dataset.

```sh
# 1. do the two builds agree, molecule by molecule?
node --experimental-strip-types benchmark/wasmParity.mjs idcodes.txt

# 2. how much faster is it, on the same candidates, in one process?
node --experimental-strip-types benchmark/wasmVerify.mjs idcodes.txt 10000

# 3. does the whole search return the same entries, in the same order?
node --experimental-strip-types benchmark/seedIdCodes.mjs idcodes.txt bench.sqlite 60000
node --experimental-strip-types benchmark/wasmSearch.mjs bench.sqlite
```

`wasmParity` compares fingerprints word for word and match positions one by one;
`wasmSearch` runs the real pipeline — clustered prescreen, batching, `maxResults`
cutting the scan short — and compares the entry ids in order. Both exit non-zero
on any disagreement, so they can be run as a gate.
