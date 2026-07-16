# openchemlib-sqlite

[![NPM version](https://img.shields.io/npm/v/openchemlib-sqlite)](https://www.npmjs.com/package/openchemlib-sqlite)
[![Node.js CI](https://github.com/cheminfo/openchemlib-sqlite/workflows/Node.js%20CI/badge.svg)](https://github.com/cheminfo/openchemlib-sqlite/actions/workflows/nodejs.yml)

SQLite-backed molecular search using [OCL (openchemlib-js)](https://github.com/cheminfo/openchemlib-js).
Adds substructure, exact, and similarity search on top of an **existing** molecules table that you own.

## Requirements

- Node.js ≥ 22.5 (uses the built-in `node:sqlite` module)
- `openchemlib` peer dependency ≥ 9.20.1

## Installation

```sh
npm install openchemlib-sqlite openchemlib
```

## How it works

`openchemlib-sqlite` does **not** create or own a molecules table. It works alongside an existing table that contains at minimum:

- a primary key column (default: `id`)
- an `id_code` column holding the OCL idCode string (default column name: `id_code`)
- optionally an `id_code_no_stereo` column for stereo-insensitive exact search

`migrate()` creates an `ocl_ss_index` table storing the 512-bit fingerprint for each indexed entry, referencing the entries table by its primary key, plus an `ocl_ss_schema` table recording the schema version. Call it on every startup: it applies whatever a database is missing and upgrades one written by an older release in place — see [Upgrading](#upgrading).

## Setup

```js
import { DatabaseSync } from 'node:sqlite';
import * as OCL from 'openchemlib';
import { MoleculesDBSQLite } from 'openchemlib-sqlite';

const db = new DatabaseSync('molecules.db');

// Your molecules table (already exists, or create it here):
db.exec(`
  CREATE TABLE IF NOT EXISTS molecules (
    id                INTEGER PRIMARY KEY,
    id_code           TEXT NOT NULL UNIQUE,
    id_code_no_stereo TEXT NOT NULL
  )
`);

// Point the library at it:
const molDB = new MoleculesDBSQLite(db, OCL, {
  entriesTable: 'molecules',
  idCodeNoStereoColumn: 'id_code_no_stereo', // omit if not needed
});
molDB.migrate(); // creates or upgrades ocl_ss_index (idempotent)
```

`MoleculesDBConfig` options:

| Option                 | Default      | Description                                                                                                  |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `entriesTable`         | _(required)_ | Name of the existing molecules table                                                                         |
| `pkColumn`             | `'id'`       | Primary key column name                                                                                      |
| `idCodeColumn`         | `'id_code'`  | Column holding the OCL idCode                                                                                |
| `idCodeNoStereoColumn` | `null`       | Column for stereo-stripped idCode; required for `exactNoStereo` mode                                         |
| `mwColumn`             | `null`       | Column holding the molecular weight (REAL); enables automatic mass-difference sorting in substructure search |

## Inserting molecules

Insert into your own table first, then index the molecule via `molDB.insert(entryId, molecule)`.

### Parsing molecules — auto-detect format

`OCL.Molecule.fromText(text)` detects the format automatically:

- string containing `V2000` or `V3000` → parsed as molfile
- otherwise tries SMILES first, then idCode

```js
const mol = OCL.Molecule.fromText(unknownFormatString);
if (!mol) throw new Error(`Could not parse: ${unknownFormatString}`);
```

### Full insert example

```js
const mol = OCL.Molecule.fromText('Cn1c(=O)c2c(ncn2C)n(C)c1=O'); // auto-detects SMILES
if (!mol) throw new Error('Could not parse molecule');

const idCode = mol.getIDCode();

// Compute stereo-stripped idCode without mutating the original
const molNoStereo = mol.getCompactCopy();
molNoStereo.stripStereoInformation();
const idCodeNoStereo = molNoStereo.getIDCode();

const { lastInsertRowid } = db
  .prepare('INSERT INTO molecules (id_code, id_code_no_stereo) VALUES (?, ?)')
  .run(idCode, idCodeNoStereo);

// Index the molecule — pass the Molecule instance or an idCode string
molDB.insert(Number(lastInsertRowid), mol);
```

Passing a `Molecule` instance to `insert()` avoids a redundant re-parse. Passing an idCode string is also valid:

```js
molDB.insert(Number(lastInsertRowid), idCode);
```

## Searching

All search modes return a `SearchResponse` with `results`, `total`, and optional `partial` / `screened` fields.
Each result contains `{ entryId, idCode }` — use `entryId` to look up additional data in your own table.

The query can be a string (parsed with `options.format`) or a `Molecule` instance (format option is ignored).
The library sets the fragment flag automatically: `false` for `exact` / `exactNoStereo` / `similarity`,
`true` for `substructure`. If the flag needs to change on a passed-in instance, a compact copy is made so the
original is never mutated.

### Exact match

```js
const { results } = molDB.search('Cn1c(=O)c2c(ncn2C)n(C)c1=O', {
  mode: 'exact',
  format: 'smiles',
});

// Passing a Molecule instance directly:
const { results } = molDB.search(
  OCL.Molecule.fromSmiles('Cn1c(=O)c2c(ncn2C)n(C)c1=O'),
  {
    mode: 'exact',
  },
);
```

### Exact match ignoring stereocenters

Requires `idCodeNoStereoColumn` to be configured.

```js
const { results } = molDB.search('NC(C)C(=O)O', {
  mode: 'exactNoStereo',
  format: 'smiles',
});
// returns both L-alanine and D-alanine
```

### Substructure search

```js
const { results, screened, partial } = molDB.search('c1ccccc1', {
  mode: 'substructure',
  format: 'smiles',
  timeoutMs: 10000,
});
```

A 512-bit fingerprint prefilter (bitwise AND) discards non-candidates before running the full OCL substructure check.

**Empty query optimization** — passing a molecule with no atoms (e.g. `new OCL.Molecule(0, 0)`) skips the fingerprint prefilter entirely and returns every indexed entry, because an empty fragment matches everything.

### Substructure search sorted by mass difference

When `mwColumn` is configured, substructure results are **automatically** ranked by ascending `|queryMw − resultMw|`. A molecule whose mass equals the query mass (an exact structural match) therefore appears first, with no extra option required:

```js
// Schema must include a molecular-weight column, e.g.:
//   mw REAL NOT NULL
// Construct MoleculesDBSQLite with mwColumn: 'mw' to enable automatic sorting.

const { results } = molDB.search('c1ccccc1', {
  mode: 'substructure',
  format: 'smiles',
});
// results[0] is the molecule whose mass is closest to benzene's MW (~78 Da).
// Each result carries a .mw field with the value from the database.
```

The molecular weight of the query is computed with `fragment = false` on a temporary copy so the original `Molecule` instance is never mutated.

### Similarity search (Tanimoto)

```js
const { results } = molDB.search('Cn1c(=O)c2c(ncn2C)n(C)c1=O', {
  mode: 'similarity',
  format: 'smiles',
  similarityThreshold: 0.4,
});
// results sorted by descending similarity; each entry has a .similarity field
```

### Pagination

```js
const { results, total } = molDB.search(query, {
  mode: 'substructure',
  format: 'smiles',
  limit: 50,
  from: 0,
});
```

### Restricting a search to candidates

A scan's cost is dominated by parsing and matching each candidate molecule, so
when the caller already knows which entries are relevant — from an attribute
filter, an earlier query, anything expressible in SQL — hand that over as a
subquery instead of filtering the results afterwards, which pays for the full
scan first:

```js
const { results, total } = await molDB.search('c1ccccc1', {
  mode: 'substructure',
  format: 'smiles',
  candidates: {
    sql: 'SELECT id AS entry_id FROM ligands WHERE name LIKE :name',
    params: { name: '%acetate%' },
  },
});
```

What you stop paying for is the candidates that are never verified, so the gain
is proportional and grows with the table size. Measured on 50 000 CCD ligands
(8 cores), restricting a phenazine scan to the 9 232 entries matching that
filter: **199 ms → 50 ms**.

`sql` must select exactly one column, named `entry_id`, and `params` must use
**named** parameters (`:name`) since the prescreen binds its own anonymous ones.
Every mode honours it (`substructure`, `similarity`, `exact`, `exactNoStereo`).
Because the prescreen runs once per search, so does the subquery — however many
verifier threads are running.

## How a substructure search runs

A substructure search is two steps, and they cost very different amounts:

| step      | what it does                                                                                | share of the time |
| --------- | ------------------------------------------------------------------------------------------- | ----------------- |
| prescreen | one SQL scan of `ocl_ss_index`, keeping rows whose fingerprint is a superset of the query's | ~3%               |
| verify    | parse each surviving candidate and run the graph match                                      | ~97%              |

So the prescreen is left alone: a single query, on the calling thread's
connection, streamed. Only the verification is spread over `poolSize` threads,
which receive the fragment once and then answer batches of idCodes with
match / no-match. They hold no database connection.

Two properties fall out of that:

- **It self-balances.** Batches go to whichever thread is free, so the split
  never depends on guessing how candidates are distributed. On 50 000 CCD
  ligands a full phenazine scan goes 710 ms → 199 ms (1 → 8 threads).
- **Concurrent searches share the pool.** The verifiers are stateless and cache
  each fragment they see, so several searches interleave on the same threads
  instead of each monopolising them.

### Why the index is ordered by molecular weight

`ocl_ss_index` is `WITHOUT ROWID` with primary key `(mw, entry_id)`, so the table
is _physically_ stored lightest-first. Nothing ever has to sort it: scanning it
is already the right order, and the prescreen is a genuine row-by-row cursor
rather than a materialised result set. Two things follow.

**`maxResults` really stops the scan.** It is not a slice of a finished result:
the cursor is abandoned mid-table, so the candidates past it are never read, let
alone parsed. A benzene scan of 50 000 ligands whose prefilter admits 36 801
candidates reads only ~1 400 of them and returns in 16 ms instead of 787 ms.

**What survives an early stop is the smallest superstructures** — the matches
closest to the query — rather than an arbitrary insertion-order subset.

This is why `candidates` uses `+s.entry_id IN (…)`. The unary `+` marks the term
unusable by an index, which keeps `ocl_ss_index` as the driving table. Without
it SQLite drives the scan off the subquery — the smaller side, and one with no
statistics — which throws the physical order away and needs a temp b-tree to
rebuild it, materialising every candidate before the first row comes out. Forcing
the clustered scan keeps a restricted search streaming and lightest-first exactly
like an unrestricted one (24 ms vs 70 ms on the benzene scan above).

## Schema

`migrate()` creates two tables:

```sql
ocl_ss_index  (mw, entry_id, ss_index0 .. ss_index7)  -- WITHOUT ROWID, PK (mw, entry_id)
ocl_ss_schema (version, applied_at)                   -- which schema version this database is at
```

`entry_id` is a foreign-key reference to your entries table's primary key column, with a unique index
of its own. The eight `ss_indexN` columns store the 512-bit OCL fingerprint packed as signed 64-bit
integers for efficient SQL bitwise prefiltering. `mw` leads the primary key so the table is physically
stored lightest-first — see [above](#why-the-index-is-ordered-by-molecular-weight).

## Upgrading

**Call `migrate()` on every startup.** It is idempotent, it records the schema version it reaches, and
it applies only what a database is missing — so it does nothing once current and upgrades in place when
it is not. There is no separate command to run and no dump/reload:

```js
const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'ligands' });

molDB.migrate({
  // Upgrading a large index rewrites every row. Log it: a startup that is
  // working should not look like one that has hung.
  onMigration: (event) => logger.info(event, 'ocl_ss_index migration'),
});
```

`migrate()` returns the versions it applied (`[]` when there was nothing to do), and `onMigration`
receives a `start` / `progress` / `done` event per version, carrying `done` / `total` rows while a
version runs and `elapsedMs` when it finishes.

Upgrades reuse whatever the old schema already held rather than recomputing it. Going from the 2.x
index to the mw-clustered one, for instance, carries the fingerprints over untouched — they are the
expensive part (~6 ms a molecule) and the schema change does not affect them; only `mw` is new.
Measured on 49 983 CCD ligands:

|                                                        | time       |
| ------------------------------------------------------ | ---------- |
| `mwColumn` configured — weights come straight from SQL | **105 ms** |
| no `mwColumn` — weights derived from each idCode       | **2.7 s**  |

Compare with ~5 minutes to re-fingerprint the same index from scratch.

Each version is applied in its own transaction, so an interrupted upgrade leaves the database at the
last version that fully completed — never half-way through one. A migration only ever discards rows it
cannot carry (an orphaned fingerprint whose entry no longer exists, which no search could return), and
reports the count as `dropped` rather than dropping it quietly.

### Adding a schema version

Append to `MIGRATIONS` in `src/migrations.ts`; never edit a shipped migration, since it has already run
on real databases. Databases created before `ocl_ss_schema` existed are recognised once by shape and
recorded from then on.

## Using a different SQLite driver

The constructor accepts any object satisfying the `SQLiteDatabase` duck-typed interface (compatible with
[`node:sqlite`](https://nodejs.org/api/sqlite.html) and [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)):

```ts
import { MoleculesDBSQLite, type SQLiteDatabase } from 'openchemlib-sqlite';

const db: SQLiteDatabase = /* any compatible driver */;
```

> **Note**: Substructure and similarity searches call `stmt.setReadBigInts(true)` when available (node:sqlite).
> For other drivers, configure BigInt return for INTEGER columns at the driver level.

## License

MIT
