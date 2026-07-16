// Seed a benchmark database from the wwPDB Chemical Component Dictionary.
//
//   node --experimental-strip-types benchmark/seedCCD.mjs components.cif.gz bench.sqlite
//
// Real molecules matter here: their molecular weights are heavily skewed and
// their fingerprints let realistic numbers of candidates through, neither of
// which a synthetic dataset reproduces.
import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip } from 'node:zlib';

import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';

const { moleculeFromCif } = await import('cif-to-json');

const CCD = process.argv[2];
const DB_PATH = process.argv[3];
if (!CCD || !DB_PATH) {
  throw new Error('usage: seedCCD.mjs <components.cif.gz> <db.sqlite>');
}

// Mirrors backend/src/ccd/splitCifBlocks.js: accumulate lines into data_ blocks.
async function* splitCifBlocks(lines) {
  let block = [];
  for await (const line of lines) {
    if (line.startsWith('data_') && block.length > 0) {
      yield block.join('\n');
      block = [];
    }
    block.push(line);
  }
  if (block.length > 0) yield block.join('\n');
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = OFF');
db.exec(`
  CREATE TABLE IF NOT EXISTS ligands (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT,
    id_code TEXT NOT NULL,
    mf TEXT,
    mw REAL,
    nb_atoms INTEGER
  )
`);

// Same config as pdb-quickview's buildMoleculesDB (no mwColumn configured).
const molDB = new MoleculesDBSQLite(db, OCL, {
  entriesTable: 'ligands',
  pkColumn: 'id',
  idCodeColumn: 'id_code',
});
molDB.migrate();

const insertLigand = db.prepare(
  `INSERT INTO ligands (code, name, type, id_code, mf, mw, nb_atoms)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET name = excluded.name
   RETURNING id`,
);

let imported = 0;
let skipped = 0;
const start = Date.now();
const fileHandle = await open(CCD, 'r');
const lines = createInterface({
  input: fileHandle.createReadStream().pipe(createGunzip()),
  crlfDelay: Infinity,
});

db.exec('BEGIN');
for await (const cifText of splitCifBlocks(lines)) {
  let parsed;
  try {
    parsed = moleculeFromCif(cifText, OCL.Molecule);
  } catch {
    skipped++;
    continue;
  }
  if (!parsed) {
    skipped++;
    continue;
  }
  const { molecule, code, name, type, nbAtoms } = parsed;
  let idCode;
  let mf;
  let mw;
  try {
    idCode = molecule.getIDCode();
    const formula = molecule.getMolecularFormula();
    mf = formula.formula;
    mw = formula.relativeWeight;
  } catch {
    skipped++;
    continue;
  }
  if (!idCode) {
    skipped++;
    continue;
  }
  const row = insertLigand.get(code, name ?? '', type ?? '', idCode, mf, mw, nbAtoms ?? 0);
  molDB.insert(Number(row.id), molecule);
  imported++;
  if (imported % 2000 === 0) {
    db.exec('COMMIT');
    console.log(`  imported=${imported} skipped=${skipped} (${Date.now() - start}ms)`);
    db.exec('BEGIN');
  }
}
db.exec('COMMIT');
db.exec('ANALYZE');

console.log(`DONE imported=${imported} skipped=${skipped} in ${Date.now() - start}ms`);
console.log('ligands:', db.prepare('SELECT COUNT(*) AS n FROM ligands').get());
console.log('ocl_ss_index:', db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get());
db.close();
