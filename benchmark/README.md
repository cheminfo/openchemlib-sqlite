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
