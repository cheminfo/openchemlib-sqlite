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
whether it can replace `openchemlib` here: two check that it answers _exactly_
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

## What do the structure hashes cost?

`exactNoStereo` and `exactNoStereoTautomer` match on hashes that have to be built
for every entry first, and the two are nothing alike: the no-stereo hash costs
~74 µs a molecule, the tautomer one averages ~22 ms and its slowest take seconds.
That ~300x gap is why `backfillHashes()` runs them as separate passes with the
cheap one first, and the tautomer tail is why it caps each molecule at 100 ms.

```sh
node --experimental-strip-types benchmark/structureHash.mjs idcodes.txt 3000
```

It prints both hashes' per-molecule distributions, then what several caps give up
and what they save — including the ~50 ms of destroying a worker and starting a
fresh one, which is the only way to stop a canonization already running. It also
checks that hashing one molecule at a time costs the same as a batched call,
which is what makes a per-molecule cap affordable.

## Plane index: `planeScan.mjs`

```sh
node benchmark/planeScan.mjs 2000000 /tmp/planeScan.sqlite
```

Real molecules, synthetic library: ~8 600 fingerprints are computed from
combinatorial SMILES and sampled with replacement, so bit marginals **and bit
correlations** are those of real structures. A fingerprint drawn bit by bit from
independent marginals is useless here — every multi-bit query returns nothing.

Only the prescreen is measured; verification is unchanged. `column` is today's
`ocl_ss_index` scan, `screen` is the plane intersection alone, `plane` is the
intersection plus turning survivors back into candidates.

At 2 000 000 entries, warm cache:

| query            | bits | used | column    | screen   | plane    | candidates |
| ---------------- | ---- | ---- | --------- | -------- | -------- | ---------- |
| benzene          | 3    | 0    | 10 486 ms | —        | declined | 1 381 568  |
| phenol           | 8    | 3    | 3 921 ms  | **3 ms** | 1 446 ms | 272 568    |
| naphthalene      | 4    | 1    | 2 005 ms  | **1 ms** | 3 635 ms | 677 014    |
| biphenyl-F       | 13   | 7    | 216 ms    | **6 ms** | 14 ms    | 0          |
| benzamide        | 21   | 9    | 860 ms    | **9 ms** | 995 ms   | 127 105    |
| sulfonamide-aryl | 24   | 12   | 407 ms    | **6 ms** | 47 ms    | 0          |

Three things to read out of it.

**The screen stops being the cost.** 1–9 ms against a column scan of 216 ms to
10.5 s, and it is flat in the number of candidates because it only reads the
planes of the bits the query sets. This is the whole point of the index.

**What is left is resolving survivors**, at roughly 5 µs each, which no index
removes — a candidate has to be verified. So the plane path wins by the margin
the screen saves and loses nothing else: selective fragments are 15–18× faster,
and a fragment matching a third of the library is a wash.

**A fragment whose every bit is too common is declined**, and belongs on the
column path, which is clustered by molecular weight and stops early. Benzene in
this library is in 69% of entries; there is nothing to screen.

With `exactFilter: false` (leaving the real matcher to reject the screen's false
positives instead of checking each survivor's stored 512-bit fingerprint),
resolution roughly halves and the plane path is never slower than the column one:

| query            | column | exactFilter on | off        |
| ---------------- | ------ | -------------- | ---------- |
| phenol           | 405 ms | 654 ms         | **275 ms** |
| naphthalene      | 773 ms | 1 731 ms       | **745 ms** |
| benzamide        | 276 ms | 371 ms         | **157 ms** |
| biphenyl-F       | 162 ms | 9 ms           | **9 ms**   |
| sulfonamide-aryl | 151 ms | 10 ms          | **10 ms**  |

On this library the exact filter rejected **nothing at all** — 0 false positives
on every query — because a fragment's rare bits already imply its common ones.
That rate is a property of the corpus, so the filter stays on by default: a false
positive reaching verification costs a `fromIDCode` parse, measured at ~625 µs.

Index size at 2 M entries: `ocl_ss_plane` 98.6 MB and `ocl_ss_slot` 24.1 MB,
against 196.8 MB for `ocl_ss_index` itself. The fold took 76 s, about 38 µs per
entry.

### Routed, which is what a search actually does

`choosePrescreenPath()` picks per query, by measuring: it intersects the planes,
counts what survives, and takes the plane path only when the count is small
enough that verification will not swamp the saving **and** below `maxResults`, so
no truncation can make the slot order observable. Both columns below run the same
dispatcher, the baseline with the plane index switched off, so the only
difference is the routing.

| query            | bits | used | plane index off | screen | routed   | path      | speedup  |
| ---------------- | ---- | ---- | --------------- | ------ | -------- | --------- | -------- |
| benzene          | 3    | 0    | 1 716 ms        | —      | 1 792 ms | column    | 1.0×     |
| phenol           | 8    | 3    | 509 ms          | 2 ms   | 487 ms   | column    | 1.0×     |
| naphthalene      | 4    | 1    | 994 ms          | 1 ms   | 962 ms   | column    | 1.0×     |
| biphenyl-F       | 13   | 7    | 145 ms          | 3 ms   | 24 ms    | **plane** | **5.9×** |
| benzamide        | 21   | 9    | 299 ms          | 6 ms   | 311 ms   | column    | 1.0×     |
| sulfonamide-aryl | 24   | 12   | 142 ms          | 5 ms   | 22 ms    | **plane** | **6.5×** |

(The router has since changed: a bounded scan now starts on the column path and
may switch to the planes at a checkpoint — see `firstPages.mjs` below. The
unbounded rule is the one measured here.)

Never slower, 6× where the screen pays. Deciding is free in practice — the
intersection it has to run to decide costs 1–6 ms, and it is thrown away when the
answer is no.

Two measurement notes, because both bit me while writing this file. The baseline
has to run through the same generator: counting raw rows instead flatters it by
~25%, because a real search builds a candidate object per row. And A/B passes
have to be **interleaved** — three A passes then three B let machine drift land
on one side and showed phantom regressions down to 0.76×.

## Filters: `filteredScan.mjs`

```sh
node --experimental-strip-types benchmark/seedIdCodes.mjs idcodes.txt bench.sqlite
node --experimental-strip-types benchmark/filteredScan.mjs bench.sqlite 115
```

A filter on something the index does not hold reaches the scan as a `candidates`
subquery, and how it is applied decides what a page costs. The difference is one
of scale, so the script first writes a copy of the bench database with every entry
and fingerprint repeated `copies` times, never recomputed, and gives each entry two
attributes to filter on: `band` (id % 100, no index) and `tag` (id % 10000,
indexed). Every strategy of a case must give the same answer, or it says so.

Measured on 4 023 045 entries (115 copies of 34 983 real molecules), benzene, a
page of 24, best of three, node 24:

| filter                     | membership | probe     | drive      | `mwRange` + probe |
| -------------------------- | ---------- | --------- | ---------- | ----------------- |
| `mw >= 260 AND band < 80`  | 497 ms     | —         | —          | **3.6 ms**        |
| `band = 7` (1%, no index)  | 107 ms     | **11 ms** | —          | —                 |
| `tag = 7` (0.01%, indexed) | 115 ms     | 214 ms    | **3.7 ms** | —                 |

- A **membership** list costs the subquery, whatever the page: the broad filter
  lists 2.4 M ids before the first candidate is read, and that grows with the
  database — ten times the entries, ten times the wait.
- A **probe** costs the page: the scan streams lightest-first and stops at 24.
  It loses only when nearly every candidate is rejected, which is where…
- …**drive** wins: it reads the few candidates' fingerprints through the entry
  index and sorts them, so its cost is the subquery's own.
- A weight bound is a **seek** with `mwRange`; written into the subquery it is a
  test on every row, or, as membership, part of the list.

## Computing the similarity inside SQLite

```sh
node --experimental-strip-types benchmark/similarityScan.mjs bench.sqlite
node --experimental-strip-types benchmark/similarityScan.mjs search-naturals.sqlite collection_members id idCode
```

An A/B in one process: the Tanimoto coefficient computed in JavaScript for every
row, as the scan did, against the same coefficient computed by a SQL function
with the threshold in the WHERE clause, so only the hits leave SQLite. It checks
that both return the same entries with the same coefficients before timing them.

## Preparing the insert once

```sh
node --experimental-strip-types benchmark/insertPrecomputed.mjs 20000
```

An A/B in one process: a precomputed fingerprint written through a statement
prepared for every insert, as `insert()` did, against one prepared once.

## Inserting without a tail: `tailInsert.mjs`

```sh
node benchmark/tailInsert.mjs 1000
```

An A/B in one process: batches of 1 000 increasing ids written into a file
whose `ocl_ss_index` carries version 5's tail trigger, which copied every row
into `ocl_ss_tail`, against version 6's watermark triggers, against no trigger
at all. Both schemas are written out in the script, so it measures the same
thing whichever version is checked out.

Node 24.15, WAL, `synchronous = OFF`, 30+ samples each (±1.5–2.4%):

| schema                             | rows/s  | ns/row |
| ---------------------------------- | ------- | ------ |
| version 5, tail (5.2.0)            | 40 812  | 24 502 |
| version 6, never folded            | 139 446 | 7 171  |
| version 6, ids above the watermark | 138 246 | 7 233  |
| no trigger at all                  | 189 027 | 5 290  |

Without the tail an insert is **3.4× faster**: it writes one clustered row and
one index entry instead of two of each. The watermark triggers cost ~1.9 µs a
row over no trigger, whether or not anything was folded, and the same with one
trigger as with two — most of it is the table having triggers at all.

Bun has no `node:sqlite`, so neither this nor `foldedSearch.mjs` runs there.

## Searching a folded index: `foldedSearch.mjs`

```sh
node benchmark/foldedSearch.mjs 200000
```

One synthetic library (the `planeScan.mjs` pool, sampled with replacement) in
four files: never folded; folded; folded with 1% more inserted since, above the
watermark; folded with 10% more, past the 5% the router accepts. Whole searches
on one thread — prescreen and verification — with no result cache, 30+ samples
each.

At 200 000 entries, Node 24.15:

| query            | unfolded   | folded   | +1% above | +10% above | matches |
| ---------------- | ---------- | -------- | --------- | ---------- | ------- |
| biphenyl-F       | 19.2 ms    | **15.5** | 18.2      | 24.9       | 0       |
| sulfonamide-aryl | 17.4 ms    | **11.5** | 14.4      | 22.5       | 0       |
| thiophene-amide  | 59.3 ms    | 63.3     | 63.8      | 67.4       | 3 174   |
| benzamide        | 229.5 ms   | 233.2    | 234.7     | 256.4      | 12 869  |
| naphthalene      | 1 139.2 ms | 1 149.6  | 1 160.6   | 1 264.5    | 47 258  |
| benzene          | 2 022.7 ms | 2 031.9  | 2 030.9   | 2 217.6    | 88 202  |

The plane index pays where the prescreen is the search: a selective fragment
with few matches, 30–35% faster here and more as the library grows, since the
column scan grows with it and the planes do not. A fragment with thousands of
matches is verification-bound, so the router sends it to the column scan, and
deciding costs the few milliseconds of the intersection. 1% of the library
inserted since the fold costs ~3 ms of seeks on the entry index; at 10% the
router has gone back to the column scan, which also reads the 10% more entries.

## First pages on a folded index: `firstPages.mjs`

```sh
node benchmark/firstPages.mjs synthetic 200000
node benchmark/firstPages.mjs new-10M.sqlite new-10M-folded.sqlite molecules-10M.sqlite
```

The same index never folded and folded, searched in one process by one build:
first pages of 24 and 96 results with a 10 s budget, and full counts. The plane
index must never make a page slower, and should make a full count faster when
few entries survive its screen. Each line prints the matches and the first ids,
so the two can be checked for the same answer. With files, the entries are
attached as `mol.molecules (id, idCode)` — the layout of the PubChem copies —
and six verifier threads run, as molecules.cheminfo.org's server does.

The first 10 M molecules of PubChem, warm, node 26.7, a shared 20-core machine
(load 8–23), 30+ samples each:

| fragment           | page | never folded | folded, 5.2.0's router | folded, this router |
| ------------------ | ---- | ------------ | ---------------------- | ------------------- |
| benzene            | 24   | 10.9 ms      | 16.0 ms                | 10.9 ms             |
| benzene            | 96   | 12.2 ms      | 17.1 ms                | 13.2 ms             |
| pyridine           | 24   | 9.5 ms       | 27.7 ms                | 9.1 ms              |
| pyridine           | 96   | 11.2 ms      | 30.7 ms                | 12.2 ms             |
| flavone            | 24   | 84.9 ms      | 486.1 ms               | 82.1 ms             |
| flavone            | 96   | 117.0 ms     | 512.7 ms               | 114.9 ms            |
| steroid            | 24   | 308.5 ms     | 543.7 ms               | 293.6 ms            |
| steroid            | 96   | 251.9 ms     | 523.8 ms               | 290.9 ms            |
| quercetin          | 24   | 257.6 ms     | 840.4 ms               | 163.4 ms            |
| quercetin          | 96   | 786.3 ms     | 1 335.0 ms             | 171.9 ms            |
| dibenzoselenophene | 24   | 1 861.9 ms   | 1 960.3 ms             | 379.7 ms            |
| dibenzoselenophene | 96   | 1 859.2 ms   | 1 945.7 ms             | 174.2 ms            |
| cubane             | 24   | 76.3 ms      | 225.7 ms               | 74.6 ms             |
| cubane             | 96   | 835.4 ms     | 1 080.6 ms             | 665.1 ms            |
| flavone            | all  | 1 550.5 ms   | 1 261.5 ms             | 446.4 ms            |
| quercetin          | all  | 1 269.0 ms   | 1 443.5 ms             | 222.8 ms            |
| dibenzoselenophene | all  | 1 888.0 ms   | 541.3 ms               | 152.3 ms            |

The old router intersected every plane of the query before reading a
candidate, to decline a first page anyway; the new one starts a bounded scan on
the column path, reads planes one at a time and only while they pay, and when
it moves to the planes reads them in the column path's order from where it
stopped. Every variant returned the same matches and the same first ids.
