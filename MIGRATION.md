# Porting molecules.cheminfo.org to openchemlib-sqlite 6.0

What the app must create, and how it calls the store and the index. The schema is
`out/schema-v3.sql` of the molecules checkout; the library creates its three tables itself.

## 1. The app's tables

Create, in `data/sqlite/db.sqlite` (one file, 4 KiB pages, WAL), everything of `schema-v3.sql`
except `ocl_molecule`, `ocl_tile` and `ocl_meta`: `formulas`, `molecules` (keyed by the library's
id, no idCode, no hashes, no `ssIndex`), `sources`, `tokens`, `molecule_sources`, `counters`,
`stats`, `stats_mass`, their indexes, and the triggers (counts, `listed`, guards).

Open the store before inserting any app row: `MoleculeStore.open(db)` creates the library's
tables, and `molecules.id REFERENCES ocl_molecule (id)`.

## 2. The change log

The index re-reads every molecule the log names: its columns (order key and filters) and its
sets. Every change to anything the spec's SQL reads must therefore be logged, in the writer's own
transaction. `schema-v3.sql` has the table and four triggers (entries inserted, deleted, moved; a
molecule deleted). Add one for the order key and the filters, which `schema-v3.sql` lacks (a
formula recomputed for B10, a property fixed):

```sql
CREATE TRIGGER entry_changes_molecule_update
AFTER UPDATE OF formulaId, logP, logS, polarSurfaceArea, acceptorCount, donorCount,
  rotatableBondCount, stereoCenterCount, nbFragments ON molecules BEGIN
  INSERT INTO entry_changes (moleculeId, sourceId) VALUES (NEW.id, 0);
END;
```

`listed` changes come from `molecule_sources` changes, which are logged already. Prune the log in
chunks, keeping enough for the index's poll interval; an index that finds it pruned past what it
applied reports it in `index.errors` and must be opened again.

## 3. Writing molecules

```js
const batch = await store.prepare(idCodes); // worker threads: canonical idCode, atom count, band,
// FragFp, screen, both hashes; nothing written
db.exec('BEGIN IMMEDIATE');
const results = store.commit(batch);
for (const [i, result] of results.entries()) {
  const molecule = batch.molecules[i];
  if (result === undefined) continue; // molecule.error
  if (result.created) insertMoleculeRow(result.id, molecule.idCode); // formula from the canonical idCode
  upsertEntry(sourceId, result.id, externalIds[i]);
}
db.exec('COMMIT');
```

- The library's rows and the app's land in the same transaction. Keep transactions short
  (≤ 500 molecules).
- `molecules.createdAt`, the formula and the properties are the app's, computed from
  `molecule.idCode` (the canonical form the library stores).
- `noStereoID`, `noStereoTautomerID` and `failedTautomerID` are no longer stored: compute them on
  demand. `ssIndex` is in the tiles; `store.keys(ids)` gives the idCode and both hashes.
- Removing a molecule (admin): delete its `molecule_sources` and `molecules` rows (logged), then
  `store.remove([id])` in the same transaction.

## 4. Identity

| Before                             | Now                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| lookup by `molecules.idCode`       | `store.find(idCodes)`                                                                   |
| "Any stereoisomer"                 | `store.stereoisomers(idCode, { after })`                                                |
| "Any tautomer"                     | `store.tautomers(idCode, { after })`                                                    |
| `byHash(es)`, naturals' candidates | `store.byHashes('idCode', 'noStereo' or 'tautomer', hashes)`: one indexed seek per hash |
| the hit's idCode and hashes        | `store.keys(ids)`                                                                       |

## 5. The index

```js
const index = await MoleculeIndex.open(
  'data/sqlite/db.sqlite',
  {
    columns: {
      sql: `SELECT m.id, f.mw, m.logP, m.logS, m.polarSurfaceArea, m.acceptorCount, m.donorCount,
            m.rotatableBondCount, m.stereoCenterCount, m.nbFragments, f.charge
          FROM molecules m JOIN formulas f ON f.id = m.formulaId
          WHERE m.id BETWEEN :from AND :to ORDER BY m.id`,
      filters: [
        { name: 'logP', type: 'float32' },
        { name: 'logS', type: 'float32' },
        { name: 'psa', type: 'float32' },
        { name: 'acceptors', type: 'int16' },
        { name: 'donors', type: 'int16' },
        { name: 'rotatable', type: 'int16' },
        { name: 'stereocentres', type: 'int16' },
        { name: 'fragments', type: 'int16' },
        { name: 'charge', type: 'int16' },
      ],
    },
    sets: {
      listed: {
        members:
          'SELECT id FROM molecules WHERE listed = 1 AND id BETWEEN :from AND :to ORDER BY id',
      },
      source: {
        names:
          "SELECT id FROM sources WHERE isPublic = 1 OR kind = 'collection'",
        members: `SELECT moleculeId FROM molecule_sources WHERE sourceId = :set
                AND moleculeId BETWEEN :from AND :to ORDER BY moleculeId`,
      },
    },
    defaultSets: ['listed'],
    changes: {
      read: 'SELECT id, moleculeId FROM entry_changes WHERE id > :after ORDER BY id LIMIT :limit',
      last: "SELECT seq FROM sqlite_sequence WHERE name = 'entry_changes'",
      first: 'SELECT min(id) FROM entry_changes',
    },
  },
  { threads: 6, readers: 6 },
);
```

- **Searches.** `index.substructure(idCode, { limit, after, sets, filters, keyMin, keyMax })`:
  `sets` is `['source:<id>', …]` for a sources filter, nothing for the listed molecules;
  `keyMin`/`keyMax` are `mwMin`/`mwMax`; the cursor is `next = { key, id }` (the mw and the id) and
  goes back as `after`. Browse without a structure is `index.browse(...)`. Similarity is
  `index.similarity(idCode, { threshold, fingerprint, after })`; pass a molecule's idCode, not a
  fragment's. The header's "N candidates" is `page.info.candidates` for a substructure page and
  `page.info.scored` for a similarity page.
- **Fingerprint choice.** `fingerprint` is `'fragFp'` (the default: today's scores), `'screen'`
  or `'both'`, per query; there is no open-time option (`similarityBits` is gone). The cursor is
  `next = { score, id, fingerprint }`: keep the fingerprint in the page's address with it, since a
  search on another fingerprint refuses the cursor (a cursor without one is read as FragFp). A
  query with no bit in the chosen fingerprint (methane has no FragFp bit) answers an empty page with
  `page.reason`, a sentence to show instead of "no hits".
- **Formula ranges** stay the app's: resolve them to a key range, or to the ids of the matching
  formulas' molecules and filter, as today; the index has no formula column.
- **Collections** are sources of kind `collection`: their members are a set (`source:<id>`), so a
  search restricted to them needs no file of its own.
- **Read your writes.** After a commit, `await index.waitForSeq(store.lastSeq())` (or `poll()`):
  the tail publishes within `pollMs` (500 ms).
- **Exports** page the search through its cursor.
- **Deploy.** The image loads at start (the prototype: 75 s at 123.7 M on 6 CPUs; not yet measured
  with 6.0 at that size): the health probe must wait for `MoleculeIndex.open()`. Use `node:24-slim` (with `procps` for the healthchecks' `pgrep`), not
  Alpine. Size the container for the image: ~48 GB at 124 M molecules, ~100 GB at 500 M.

## 6. Moving data

- From today's files: read each molecule's idCode and commit it through `prepare()`/`commit()`
  with its app rows; the multi-fragment formulas are recomputed (B10).
- Between sites: copy the whole file. A file written under another build's stamp is refused at
  open; `MoleculeStore.updates(db)` says what `MoleculeStore.rebuild()` would bring up to date.

## 7. Bit counts, and a new list of keys

- **The admin page's shares** are `store.bitCounts()`: per FragFp, screen and function key, how many
  of `molecules` hold it, in the order of `getFragFpKeys()`, `getScreenKeys()` and
  `getFunctionKeyFragments()`. Exact and read at once; null for a fingerprint not yet counted under
  this build's keys.
- **A release changing keys** (a new openchemlib-search-wasm): run `MoleculeStore.rebuild(db)` with the
  new image, in a one-off container on the live file, with a connection of its own and the
  application's `busy_timeout`, while the running image keeps serving searches and importing. Then
  deploy the new image. The old one cannot write any more and its index stops following; it can keep
  answering until the new one has loaded.
- At start, `MoleculeStore.updates(db)` says whether the file needs a rebuild, and of what.
