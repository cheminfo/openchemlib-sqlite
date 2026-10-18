# openchemlib-sqlite

[![NPM version](https://img.shields.io/npm/v/openchemlib-sqlite)](https://www.npmjs.com/package/openchemlib-sqlite)
[![Node.js CI](https://github.com/cheminfo/openchemlib-sqlite/workflows/Node.js%20CI/badge.svg)](https://github.com/cheminfo/openchemlib-sqlite/actions/workflows/nodejs.yml)

The storage and the in-memory search engine of a molecule database, in the application's own
SQLite file. Substructure, similarity and browse are answered in pages with a cursor, lightest
first by the application's order key, every page by its deadline. Everything the library stores is
computed by it from the idCode alone, through
[openchemlib-search-wasm](https://github.com/cheminfo/openchemlib-search-wasm).

Two exports:

- `openchemlib-sqlite`: `MoleculeStore`, the write side and the identity of molecules;
- `openchemlib-sqlite/index`: `MoleculeIndex`, the in-memory search engine over the same file.

## Requirements

- Node.js ≥ 22.16 (`node:sqlite`). Use a glibc image (`node:24-slim`), not Alpine: musl's
  allocator serializes multi-threaded reads.
- RAM for the index: about 183 B per molecule (the prototype's RSS was 24.9 GB at 123.7 M
  molecules at 181 B; its container is sized 48 GB).

```sh
npm install openchemlib-sqlite
```

## The file

The library owns four tables and creates them on first use. The application keys its own tables
by the same id and never writes these.

![The tables of a store, of a rebuild under way and of a migration from 5.x](docs/schema.svg)

```sql
CREATE TABLE ocl_molecule (
  id INTEGER PRIMARY KEY,         -- atomCount·2^36 + seq: the substructure floor; seq never reused
  noStereoHash INTEGER NOT NULL,  -- hash of the canonical no-stereo idCode
  tautomerHash INTEGER NOT NULL,  -- hash of the no-stereo generic tautomer (cap 5,000), else noStereoHash
  idCode TEXT NOT NULL,           -- canonical idCode
  idCodeHash INTEGER NOT NULL DEFAULT 0 -- strongHash(idCode): the exact structure
);
CREATE INDEX ocl_molecule_nostereo ON ocl_molecule (noStereoHash);
CREATE INDEX ocl_molecule_tautomer ON ocl_molecule (tautomerHash);
CREATE INDEX ocl_molecule_idcode ON ocl_molecule (idCodeHash);
CREATE TABLE ocl_tile (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE ocl_meta (name TEXT PRIMARY KEY, value ANY NOT NULL) WITHOUT ROWID;
CREATE TABLE ocl_bits (bit INTEGER PRIMARY KEY, population INTEGER NOT NULL); -- 1,536 rows
```

- **`ocl_tile`** holds the fingerprints once, as bit planes: up to 32 molecules of one cell (an atom
  count and a 1 Da band of OpenChemLib's own weight) per record of 4,292 bytes: 1,024 plane words
  (FragFp 512, then the 512-key screen), 32 seqs, 32 FragFp bit counts, the slots used. Its key is
  `(atomCount·2^16 + band)·2^21 + tileSeq`. A commit rewrites only the open tile of each cell it
  touches.
- **`ocl_bits`** counts, for each FragFp, screen and function key (rows 0–511, 512–1023 and
  1024–1535, in the order of `getFragFpKeys()`, `getScreenKeys()` and `getFunctionKeyFragments()`),
  how many stored molecules hold it. Every commit adds its new molecules and every removal takes
  them away, in the same transaction: about 2 µs a molecule (commits of 500), against 5.5 ms to
  prepare one. The function bits are computed for the counts and stored nowhere else.
- **`ocl_meta`** holds `format`, `stamp`, `seq` (the last issued), `count`, `generation`, the
  signatures, and `distinctNoStereo` and `distinctTautomer`: how many distinct identity hashes the
  molecules carry, kept exact by every commit and removal. A file written before they were kept
  gets them counted, once, when a store opens it.
- **The signatures** say what each part was computed under: `signature.identity` (canonical
  idCode, atom count, band, both hashes), `signature.fragFp` and `signature.screen` (the tiles),
  `signature.idCodeHash` (the hash of the idCode), and `counted.fragFp`, `counted.screen`,
  `counted.functions` (the bit counts). A fingerprint's
  signature digests its key list and its bits for built-in molecules: the keys catch a changed key
  no built-in molecule holds, the bits catch OpenChemLib reading the same keys differently.
- **The stamp** digests the identity, FragFp, screen and idCode hash signatures: everything a
  file stores. A file written under another stamp is refused, and opening a store recomputes 32
  sampled molecules. What a query is read into is left out: it is never stored, so a release that
  only reads queries better keeps every file.

Use `PRAGMA page_size = 4096` (the default) and WAL.

## MoleculeStore

```js
import { DatabaseSync } from 'node:sqlite';
import { MoleculeStore } from 'openchemlib-sqlite';

const db = new DatabaseSync('data/sqlite/db.sqlite');
const store = await MoleculeStore.open(db, { threads: 8 });

const batch = await store.prepare(idCodes); // worker threads, nothing written
db.exec('BEGIN IMMEDIATE');
const results = store.commit(batch); // inside the caller's transaction
for (const [i, result] of results.entries()) {
  if (result === undefined) continue; // batch.molecules[i].error says why
  if (result.created) insertAppRow(result.id, batch.molecules[i].idCode);
}
db.exec('COMMIT');
```

| Method                                    | What it does                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MoleculeStore.open(db, options)`         | creates the tables, or refuses a foreign format or stamp; recomputes `checkRows` (32) sampled molecules; `threads`, `readers` |
| `prepare(idCodes)`                        | computes the canonical idCode, atom count, band, FragFp, screen and both hashes; per-molecule `error`                         |
| `commit(batch)`                           | writes a prepared batch in the caller's transaction; `{ id, created }` per molecule; duplicates get their id back             |
| `find(idCodes)`                           | the id of each stored molecule (canonical or not), or undefined                                                               |
| `prefetch(batch, reads)`                  | the readers read the index pages a commit of the batch writes, and run the application's `reads` once per key                 |
| `stereoisomers(idCode, { after, limit })` | ids with the same no-stereo hash, in id order                                                                                 |
| `tautomers(idCode, { after, limit })`     | ids with the same tautomer hash, in id order                                                                                  |
| `byHashes(kind, hashes)`                  | ids holding each `'idCode'`, `'noStereo'` or `'tautomer'` hash: one indexed seek per hash                                     |
| `keys(ids)`                               | `{ idCode, noStereoHash, tautomerHash }` by id                                                                                |
| `remove(ids)`                             | administrative clean-up in the caller's transaction: rows deleted, tile slots emptied, seqs never reused                      |
| `count()`, `lastSeq()`                    | from `ocl_meta`                                                                                                               |
| `distinctHashes()`                        | `{ noStereo, tautomer }`: what `count(DISTINCT …)` over `ocl_molecule` answers, from `ocl_meta`                               |
| `bitCounts()`                             | `{ molecules, fragFp, screen, functions }`: per key, how many molecules hold it; null for one counted under other keys        |
| `MoleculeStore.updates(db)`               | what this build would rebuild: `{ identity, tiles, counts, rebuilding }`; writes nothing                                      |
| `MoleculeStore.rebuild(db, options)`      | brings the file to this build while the build that wrote it keeps searching it; see below                                     |
| `MoleculeStore.abandonRebuild(db)`        | stops a rebuild and frees what it built; writes resume                                                                        |
| `close()`                                 | stops the worker threads                                                                                                      |

`commit()` accepts only batches the store itself prepared: no value computed by the caller ever
reaches the library's tables.

For a connection that commits many new molecules, `readers: n` takes the reads off its thread: it
starts `n` threads with read-only connections of their own. `find()` reads the stored molecules of
the hashes it needs there, and `prefetch()` seeks, ahead of a commit, the pages of both hash indexes
where the batch's molecules go, so that the commit finds them in the operating system's cache.

### When keys change: rebuild beside, then switch

A new openchemlib-search-wasm may change keys. Its signatures then differ from the file's, and the
library knows which part to compute again:

| Changed                                    | This build                             | What `MoleculeStore.rebuild()` does                                  |
| ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------- |
| function keys                              | opens the file; their counts read null | counts them again: 2.0 ms a molecule (its function bits)             |
| screen keys                                | refuses the file, naming the screen    | computes the screen of every molecule (0.75 ms) and counts it again  |
| FragFp (OpenChemLib)                       | refuses the file, naming FragFp        | computes FragFp, and the screen if it changed too (2.4 ms with both) |
| idCode hashes, or a file without them      | refuses the file                       | adds the column and its index, and hashes every stored idCode        |
| canonization or identity hashes            | refuses the file                       | nothing: commit the idCodes into a new file                          |
| nothing (a file written before signatures) | gives the file its signatures          | counts the bits of every molecule, and adds its idCode hashes        |

The rebuild runs with the new build, in a process of its own with a connection of its own, while
the build that wrote the file keeps serving it, searches and writes alike:

1. When the idCode hashes are missing, the column and its index are added (building the index
   holds the write lock for as long), and every stored idCode is hashed, 4,096 per short write
   transaction; the hash needs no chemistry. Rows a build without the column commits meanwhile
   get 0, and are hashed at the switch.
2. A first pass writes, beside the tiles in use, new ones into `ocl_tile_next` (the same keys,
   slots and seqs; only the recomputed bits differ, so ids and the application's rows stay valid)
   and the new counts into `ocl_bits_next`, 256 tiles per short write transaction.
3. Meanwhile every `commit()` and `remove()` logs the tiles it changes (`ocl_rebuild_tiles`) and the
   molecules it removes, with their idCodes (`ocl_rebuild_removed`). Catch-up rounds then bring the
   new tiles up to date from that log: slots are taken in order and never reused, so a slot holds
   the same molecule in both tiles, or it arrived, or it left.
4. Once 512 changes or fewer are left, one transaction takes them, under the write lock, hashes
   the molecules committed since the hash pass began, and puts the new tiles in place: the tiles
   in use are renamed `ocl_tile_old`, the new ones take their name, the new counts replace those of
   the rebuilt fingerprints, the file takes the new stamp and signatures, and the generation rises.
   Writes wait for it as for any commit.
5. The replaced tiles are freed a thousand rows per transaction: dropped whole, the tiles of 200 M
   molecules would hold the write lock for 7 s.

Each step commits its progress: interrupted, `rebuild()` resumes where it stopped, and
`MoleculeStore.abandonRebuild(db)` throws its work away instead. After the switch a store opened by
the old build refuses to write ("rebuilt for another build"), and its index stops following the file
but keeps answering from what it loaded, until the new build replaces it. A store of the same build
takes the new generation and goes on. A rebuild that only counts keeps the stamp, so the index
follows the file throughout.

## MoleculeIndex

The index loads the tiles into RAM as bit planes grouped by atom count and band, follows the
commits, and answers pages. The application hands it, as SQL run at load and on each change, its
order key, its filter columns, its id sets and its change log. Caller data only filters and orders:
what can match is decided by the library's fingerprints and atom-count floor.

```js
import { MoleculeIndex } from 'openchemlib-sqlite/index';

const index = await MoleculeIndex.open(
  'data/sqlite/db.sqlite',
  {
    columns: {
      // id, the order key, then one value per filter column, for ids in [:from, :to], ordered by id
      sql: `SELECT m.id, f.mw, m.logP, f.charge FROM molecules m JOIN formulas f ON f.id = m.formulaId
          WHERE m.id BETWEEN :from AND :to ORDER BY m.id`,
      filters: [
        { name: 'logP', type: 'float32' },
        { name: 'charge', type: 'int16' },
      ],
    },
    sets: {
      listed: {
        members:
          'SELECT id FROM molecules WHERE listed = 1 AND id BETWEEN :from AND :to ORDER BY id',
      },
      source: {
        names: 'SELECT id FROM sources WHERE isPublic = 1',
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
  { threads: 6 },
);

const page = await index.substructure(queryIdCode, {
  limit: 24,
  sets: ['source:3'],
  filters: { logP: { min: 2 } },
  keyMin: 250, // a seek, not a filter
});
const next = await index.substructure(queryIdCode, {
  limit: 24,
  after: page.next,
});
```

| Method                                                | Answers                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `MoleculeIndex.open(file, spec, options)`             | loads the image with `readers` threads, or reads back its `snapshot`, then follows the file       |
| `substructure(queryIdCode, options)`                  | `{ hits: [{ id, key }], next, partial, unverified, info }`, by key then id                        |
| `browse(options)`                                     | the same walk without a structure                                                                 |
| `similarity(idCode, { threshold, fingerprint, ... })` | `{ hits: [{ id, score }], next, total, partial, fingerprint, reason, info }`, by Tanimoto then id |
| `poll()`, `waitForSeq(seq)`                           | catch up now; wait until a seq is searchable                                                      |
| `version`, `watermark`, `rowCount`, `sets`            | the version searched                                                                              |
| `saveSnapshot()`                                      | saves the index to its `snapshot` now: null, or why it was not                                    |
| `tailStats()`, `errors`, `close()`                    |                                                                                                   |

Search options: `limit` (24), `sets` (a union; default `defaultSets`), `filters` (inclusive bounds
by column), `keyMin` / `keyMax`, `budgetMs` (4,500), `signal`, and `after` (the previous page's
`next`).

- **Order.** Results come by the order key, then id, exactly. `next` is `{ key, id }`. A partial
  page (the deadline came first) is the exact prefix of the full order, and `next` continues it
  with no gap and no duplicate. `keyMin` and `keyMax` are seeks.
- **Similarity** is ranked by score with a `{ score, id, fingerprint }` cursor. A complete page
  holds the exact best hits after the cursor and the exact `total`; a partial one holds the best of
  the atom counts read (nearest the query's first) and no `next`. `info.scored` counts the rows
  whose Tanimoto was computed (inside the bit-count window and the filters): at least `total`.
- **Fingerprints.** Each similarity search chooses what it scores: `fingerprint: 'fragFp'`
  (OpenChemLib's 512 FragFp keys, the default, so scores are FragFp Tanimoto as before),
  `'screen'` (the 512 query-fragment keys) or `'both'` (1,024 bits). The index keeps each row's
  FragFp and screen bit counts (`both` is their sum) and a bit-count zone map per fingerprint, so
  the window prunes in every mode; that costs 2.25 B per row. A cursor belongs to its fingerprint:
  a search on another refuses it with an error, and a cursor without one is a FragFp cursor. A
  query that sets no bit of the fingerprint (methane has no FragFp bit) answers an empty page whose
  `reason` says so, in a sentence the caller can show.
- **Deadlines.** Every page answers by `budgetMs`. Verifications run in wasm worker threads with a
  watchdog: a verification still running past its own limit is killed, its candidates verified one
  by one, and a candidate whose check alone is killed is left out, counted in `unverified`, and
  skipped by later pages of the same query.
- **Filters.** `float64` and `int32` columns are exact; `float32` and `int16` save memory, and the
  few rows a rounded value cannot decide are tested on their exact value with the columns SQL. A row
  the columns SQL does not return, or returns without a key, is never answered.
- **Following the file.** Every `pollMs` (500) a worker thread reads the molecules above the
  watermark (placed in their band's append area, one area per band, doubling when full) and the
  molecules the change log names (their columns and sets read again). A change log pruned past what
  the index applied is reported in `errors`: open the index again.
- **Snapshot.** A large store scatters each table's pages over its file, so a load reads millions
  of pages out of order: 32.9 M molecules take 14 minutes from a USB disk. With `snapshot` set to a
  path, the image is saved there (about 200 B per molecule), and the next open reads that file in
  order, 14 s for those molecules, then catches up from its watermark and change id: the molecules
  committed since are placed, the changes read again. An open that loads saves it before its tail
  starts. Once the tail has taken in `snapshotRefreshShare` (0.05) of its rows and caught up, it
  pauses while the image is saved again, its append areas folded back into their bands as a load
  lays them out. `saveSnapshot()` saves it now. A save writes a temporary file, renamed over the old
  one once whole; the next open removes what a save cut short left. A snapshot is refused, and the
  index loaded and saved again, when another build, another specification or another database file
  (inode) wrote it, when it is cut short, when the store lacks all its newest molecules or the change
  log no longer reaches back to it, or when the store holds more new molecules than
  `snapshotStaleShare` (1) of its rows. `readSnapshotPosition(path)` reads its watermark and change
  id, so an application pruning its change log keeps what the snapshot needs.
- **Progress.** `onProgress` hears each step of the open, `snapshot` or the load's steps (then
  `save`), `tail` and `workers`, and each later `save`: as it starts, its tasks done five times a
  second (MiB for `snapshot` and `save`), and its end, with a `note` when a snapshot was refused or
  not saved.

Options: `threads`, `readers`, `blockRows` (2^22), `firstSliceRows` (65,536), `similarityUnitWords`,
`budgetMs`, `follow` (true), `pollMs`, `pollRows`, `appendBlockRows`,
`headroomRows`, `headroomShare`, `changeBatch`, `watchdogGraceMs` (1,000), `verifyChunkMinMs`
(1,500), `verifyChunkFactor` (16), `verifySingleMs` (1,000), `snapshot` (none),
`snapshotRefreshShare` (0.05), `snapshotStaleShare` (1), `onProgress`.

## Migrating from 5.x

6.0 is a new file format and a new API; nothing of 5.x is read.

- `MoleculesDBSQLite` is replaced by `MoleculeStore` (`openchemlib-sqlite`) and `MoleculeIndex`
  (`openchemlib-sqlite/index`). `migrate()`, `insert()`, `search()`, the `ocl_ss_index` table and
  its carried columns, the plane index, the SQL Tanimoto function and both hash tables are gone, and
  so are the `MIGRATIONS`, `SCHEMA_VERSION` and `fingerprintBits` exports and the
  `openchemlib-sqlite/worker` entry.
- The library no longer takes values from the caller: `mwColumn`, `trustMwColumn` and the
  precomputed entries `insert()` accepted have no equivalent. It computes the atom count, its
  weight (for the band), the fingerprints and both hashes itself.
- `maxTautomers` is gone: the enumeration stops at 5,000 tautomers, and a molecule that reaches the
  cap gets its no-stereo hash as its tautomer hash, which can differ from its 5.x value.
- The entries table is the application's: the library keys nothing by the application's id; the
  application keys its rows by the library's.
- Searches leave SQL: they run in `MoleculeIndex`, in RAM, from the tiles.
- `openchemlib` is no longer a peer dependency; Node 22.16 or later is required.
- `MoleculeStore.open()` and `MoleculeIndex.open()` refuse a 5.x file (one with an `ocl_ss_*` or
  `ocl_no_stereo_*` table) until it is migrated.

### Migrating a file in place

The 5.x tables live in the application's own file, so the file is migrated where it is, while the
5.x application keeps serving and writing it:

1. `migrateFromV5(db, { entries: { table, key, idCode } })`, from a process of its own whose
   connection has a busy timeout, with the table, its INTEGER PRIMARY KEY and its idCode column, as
   5.x was configured (`entriesTable`, `pkColumn`, `idCodeColumn`).
   It creates the 6.x tables beside the 5.x ones, which share no name with them, converts every
   entry from its idCode, a chunk per short write transaction, and records the id each entry got
   in `ocl_v5_ids` (`entry`, `id`, `error`). Triggers on the entries table log what the 5.x
   writers change meanwhile, and each call converts those entries again. A call stopped by its
   `signal` is continued by the next one.
2. Stop the 5.x writers, then call `migrateFromV5(db, { entries, finish: true })`: the last changes
   are converted, the triggers and their log removed, and the file marked migrated. A molecule no
   entry holds any more is removed, as 5.x forgot a removed entry.
3. Re-key the application's rows with `ocl_v5_ids`. Entries holding the same structure get the
   same id; an entry whose idCode cannot be read gets none, and the reason.
4. `dropV5Tables(db)` drops the 5.x tables and `ocl_v5_ids`, a few thousand rows per transaction,
   while the 6.x application serves.
5. `compactDatabase(db)` gives their pages back to the disk (`VACUUM`). It is not live: it holds the
   write lock for its whole run and needs about as much free disk as the file. Skipped, the free
   pages are reused for new rows and the file only stops shrinking.

Converting costs what committing does: about 5.5 ms of one thread per molecule.

## Tests

`npm run test` runs the brute-force checks on a committed sample of 2,095 molecules. Point
`OCL_SQLITE_IDCODES` at a file of idCodes, one per line, to run the same checks on a larger set:

```sh
OCL_SQLITE_IDCODES=/path/to/idcodes.txt npx vitest run src/search/__tests__/bruteForce.test.ts
```

`docs/schema.svg` is drawn by `npm run schema-svg` from scratch databases this checkout creates; a
test fails while the committed drawing differs, so run it after changing a table.

## License

[MIT](./LICENSE)
