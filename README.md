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

`migrate()` creates a single `ocl_ss_index` table that stores the 512-bit fingerprint for each indexed entry, referencing the entries table by its primary key.

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
molDB.migrate(); // creates ocl_ss_index (idempotent)
```

`MoleculesDBConfig` options:

| Option | Default | Description |
|---|---|---|
| `entriesTable` | *(required)* | Name of the existing molecules table |
| `pkColumn` | `'id'` | Primary key column name |
| `idCodeColumn` | `'id_code'` | Column holding the OCL idCode |
| `idCodeNoStereoColumn` | `null` | Column for stereo-stripped idCode; required for `exactNoStereo` mode |

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
const { results } = molDB.search(OCL.Molecule.fromSmiles('Cn1c(=O)c2c(ncn2C)n(C)c1=O'), {
  mode: 'exact',
});
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

The `ocl_ss_index` is clustered by molecular weight (the weight is computed from each molecule at `insert()`), so substructure results are **always** ranked by ascending `|queryMw − resultMw|`. A molecule whose mass equals the query mass (an exact structural match) therefore appears first, with no extra option required:

```js
const { results } = molDB.search('c1ccccc1', {
  mode: 'substructure',
  format: 'smiles',
});
// results[0] is the molecule whose mass is closest to benzene's MW (~78 Da).
// Each result carries a .mw field with the molecular weight.
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

## Schema

`migrate()` creates one table:

```sql
ocl_ss_index (mw, entry_id, ss_index0 .. ss_index7)
```

The table is **clustered by molecular weight** (`WITHOUT ROWID`, primary key `(mw, entry_id)`), with a
secondary unique index on `entry_id`. `entry_id` is a foreign-key reference to your entries table's
primary key column. The eight `ss_indexN` columns store the 512-bit OCL fingerprint packed as signed
64-bit integers for efficient SQL bitwise prefiltering. `mw` is computed from the molecule at `insert()`,
so the index is self-contained and substructure scans visit the lightest candidates first.

### Upgrading an existing database

Databases indexed by a version of this package from **before** molecular-weight clustering have an
`ocl_ss_index` with `entry_id` as the primary key and no `mw` column. `migrate()` detects that legacy
shape and rebuilds it in place automatically — every stored fingerprint is preserved and each row's `mw`
is recomputed from its molecule — so simply updating the package and calling `migrate()` as usual is
enough. The one-time rebuild runs in small committed batches and is resumable if interrupted. To run it
explicitly (e.g. to learn how many rows were migrated), call the exported `migrateLegacyIndexToMw(db, ocl, { entriesTable, pkColumn, idCodeColumn })`.

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
