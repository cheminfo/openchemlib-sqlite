# Porting an application to openchemlib-sqlite 6.0

How an application moves from 5.x to 6.0: what it creates, how it writes, finds and searches, and
how its data moves. The [README](./README.md) describes each call; this file gives the order of
work, with molecules.cheminfo.org as the example. Nothing of the 5.x API remains (README,
"Migrating from 5.x").

## 1. One file, the application's rows keyed by the library's id

- One SQLite file, with 4 KiB pages and WAL, holds the library's tables (`LIBRARY_SQL`:
  `ocl_molecule`, `ocl_tile`, `ocl_meta`, `ocl_bits`) next to the application's.
- `MoleculeStore.open(db)` creates the library's tables. Open it before inserting any row of the
  application, whose molecules reference `ocl_molecule (id)`.
- The application keeps no idCode, hash or fingerprint: `store.keys(ids)` gives a molecule's
  canonical idCode and its three hashes, and the fingerprints are in the tiles.
  molecules.cheminfo.org keeps, per molecule, its formula, its computed properties, `listed` and
  `createdAt`.
- The library refuses a file it cannot read, and says why:
  - a 5.x file, until it is migrated (§ 6);
  - a file of a 6.0 pre-release, whose tiles hold no function words: commit its idCodes into a new
    file, or migrate its 5.x original again;
  - a file written under another build's keys (§ 7).

## 2. The change log the index follows

The index reads the application's columns and sets again for every molecule the log names. Log, in
the writer's own transaction, every change to anything the specification's SQL reads: an entry
added, removed or moved to another molecule, a molecule removed, and an update of the order key or
of a filter column. molecules.cheminfo.org logs the last with:

```sql
CREATE TRIGGER entry_changes_molecule_update
AFTER UPDATE OF formulaId, logP, logS, polarSurfaceArea, acceptorCount,
  donorCount, rotatableBondCount, stereoCenterCount, nbFragments,
  radicalCount, isotopeCount, chargedFragmentCount ON molecules
BEGIN
  INSERT INTO entry_changes (moleculeId, sourceId) VALUES (NEW.id, 0);
END;
```

Prune the log in chunks, keeping what the index and its snapshot still need:
`readSnapshotPosition(path)` gives the snapshot's change id. An index that finds the log pruned past
what it applied reports it in `index.errors` and must be opened again.

## 3. Writing molecules

```js
const batch = await store.prepare(idCodes); // worker threads; nothing written
await store.prefetch(batch, appReads); // optional, with `readers`: warm the pages the commit writes
db.exec('BEGIN IMMEDIATE');
const results = store.commit(batch);
for (const [i, result] of results.entries()) {
  if (result === undefined) continue; // batch.molecules[i].error says why
  if (result.created) insertMoleculeRow(result.id, batch.molecules[i].idCode);
  upsertEntry(sourceId, result.id, externalIds[i]);
}
db.exec('COMMIT');
```

- `prepare()` computes, from each idCode alone, the canonical idCode, the atom count, the band,
  FragFp, the screen, the function words and the three hashes.
- `commit()` writes the library's rows inside the application's transaction, so both land
  together. Keep transactions short: 500 molecules or fewer.
- A stored molecule is recognized by one seek of the hash of its idCode, however many of its
  stereoisomers are stored: its `result.created` is false.
- The application computes its own columns (formula, properties) from `molecule.idCode`, the
  canonical form the library stores, not from what it was given.
- `readers: n` moves the lookups off the committing thread.
- Removing a molecule: delete the application's rows first, so the change log tells the index,
  then `store.remove([id])` in the same transaction.

## 4. Finding a molecule

| 5.x                             | 6.0                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| a lookup by the entries' idCode | `store.find(idCodes)`, canonical or not: one seek per idCode, a canonical form computed only when its compound is stored |
| any stereoisomer                | `store.stereoisomers(idCode, { after, limit })`                                                                          |
| any tautomer                    | `store.tautomers(idCode, { after, limit })`                                                                              |
| a lookup by hash                | `store.byHashes(kind, hashes)`, kind `'idCode'`, `'noStereo'` or `'tautomer'`: one indexed seek per hash                 |
| a hit's idCode and hashes       | `store.keys(ids)`                                                                                                        |

## 5. The index

The application hands `MoleculeIndex.open(file, spec, options)` its order key, its filter columns,
its sets and its change log, as SQL (README, "MoleculeIndex"). molecules.cheminfo.org orders by
`formulas.mw`, filters on 14 columns (logP to chargedFragments, unsaturation as an int16 of twice
its value), and gives two kinds of sets: `listed`, the default, and `source:<id>` for each public
source or collection.

- **Questions.** `browse`, `substructure` and `similarity` take one set of options: `sets` (any
  of), `allSets`, `noneSets`, `bits` (`{ all, any, none }` over the 1,536 key bits, function keys
  included), `filters`, `keyMin` and `keyMax` (seeks), `limit`, `after`, `lane`, `budgetMs` and
  `signal`.
- **Names to options.** The application turns what its users write into these: a source name into
  `source:<id>`, a functional group into its key bit with `getRecordBit()` from
  `openchemlib-search-wasm/function-keys` (`32 * word + Math.clz32(mask)`). A key the dictionary
  computes on demand has no bit: search its fragments as substructures.
- **Counts.** `count(options)` answers, exactly and in the workers, how many molecules a browse
  with the same options pages through, with per-set, per-key, membership and histogram tallies in
  the same pass. A count with a structure or a formula condition is the application's:
  molecules.cheminfo.org walks the matches in resumable rounds.
- **Lanes.** The site's own pages use `lane: 'interactive'`. Exports, counts and AI agents use
  `'bulk'`, which runs in short turns between them.
- **Formula ranges** stay the application's: the index has no formula column. Bound the key by the
  formulas' weights, and check each hit.
- **Similarity** takes `fingerprint: 'fragFp'` (the default), `'screen'`, `'both'` or
  `'functions'`. Keep it in the page's address with the cursor, which belongs to it.
- **Read your writes.** After a commit, `await index.waitForSeq(store.lastSeq())`: the tail
  publishes within `pollMs` (500 ms).
- **Deploy.**
  - Give the index a `snapshot` path: molecules.cheminfo.org reads 56 M molecules from its
    snapshot in 12 s, where a load from the tables takes minutes.
  - Size the memory for the image, about 270 B per molecule: 16 GB at 60 M, 32 GB at 120 M,
    135 GB at 500 M.
  - Make the health probe wait for `MoleculeIndex.open()`.
  - Use `node:24-slim`, never Alpine: musl's allocator serializes the readers.

## 6. Moving the data

- **In place**, while the 5.x application keeps serving: `migrateFromV5()`, then `dropV5Tables()`
  and, to give the disk back, `compactDatabase()` (README, "Migrating a file in place").
- **Into a new file**: commit every idCode with its application rows through `prepare()` and
  `commit()`. molecules.cheminfo.org does this (`npm run migrate-v6`), because its 5.x index lived
  in a second file.
- **Between hosts**: copy the file. The copy refuses the snapshot, which another file wrote, so its
  first open loads the index and saves it again.

## 7. Bit counts, and a new list of keys

- **Shares of each key.** `store.bitCounts()` gives, per FragFp, screen and function key, how many
  stored molecules hold it, exact and read at once; null for a fingerprint not yet counted under
  this build's keys.
- **A new list of keys** (an openchemlib-search-wasm with other FragFp, screen or function keys)
  changes what the tiles hold, so the file is refused until it is rebuilt.
  - Run `MoleculeStore.rebuild(db)` with the new build, from a process of its own, while the running
    application keeps serving and importing.
  - Then deploy the new build. The old one can no longer write, and its index stops following.
- At start, `MoleculeStore.updates(db)` says whether the file needs a rebuild, and of what.
