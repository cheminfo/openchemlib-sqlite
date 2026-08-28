// Seed a benchmark database from a plain list of idcodes.
//
//   node --experimental-strip-types benchmark/seedIdCodes.mjs idcodes.txt bench.sqlite [count]
//
// A lighter alternative to seedCCD.mjs when the molecules are already idcodes. Fingerprints are
// built by `openchemlib` through MoleculesDBSQLite.insert, so the database is exactly what the
// library produces today and nothing under test took part in building it.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';

const FILE = process.argv[2];
const DB_PATH = process.argv[3];
const COUNT = process.argv[4] ? Number(process.argv[4]) : Infinity;
if (!FILE || !DB_PATH) {
  throw new Error('usage: seedIdCodes.mjs <idcodes.txt> <db.sqlite> [count]');
}

const idCodes = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
if (idCodes.length > COUNT) idCodes.length = COUNT;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = OFF');
db.exec(`
  CREATE TABLE IF NOT EXISTS ligands (
    id INTEGER PRIMARY KEY,
    id_code TEXT NOT NULL UNIQUE
  )
`);

const molDB = new MoleculesDBSQLite(db, OCL, {
  entriesTable: 'ligands',
  pkColumn: 'id',
  idCodeColumn: 'id_code',
});
molDB.migrate();

const insertLigand = db.prepare(
  'INSERT INTO ligands (id_code) VALUES (?) ON CONFLICT(id_code) DO NOTHING RETURNING id',
);

const start = Date.now();
let imported = 0;
let skipped = 0;
db.exec('BEGIN');
for (const idCode of idCodes) {
  const row = insertLigand.get(idCode);
  if (!row) {
    skipped++;
    continue;
  }
  try {
    molDB.insert(Number(row.id), idCode);
  } catch {
    skipped++;
    continue;
  }
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
console.log('ocl_ss_index:', db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get());
db.close();
