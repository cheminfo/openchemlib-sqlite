// A/B: first pages and full counts on a folded plane index, against the same index never folded.
//
// One library in two (or three) files — never folded, folded, and optionally folded with entries
// inserted since — searched by the same build in one process. A first page (24 or 96 results, a
// 10 s budget) is what a browse sends; a full count reads every candidate. The plane index must
// never make the first slower, and should make the second faster when few entries survive the
// screen. Each line prints the matches and the first ids, so the variants can be checked for the
// same answer.
//
//   node benchmark/firstPages.mjs synthetic [entries]
//   node benchmark/firstPages.mjs <unfolded.sqlite> <folded.sqlite> <entries.sqlite> [more.sqlite]
//
// With files, the entries are attached as `mol.molecules (id, idCode)`, the layout of the PubChem
// copies the 10 M benchmark runs on; the verifier pool has 6 threads, as molecules.cheminfo.org's
// server does.
import { copyFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import { XSadd } from 'ml-xsadd';
import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from '../src/index.ts';
import { packSSIndex } from '../src/utils/packSSIndex.ts';

import { syntheticPool } from './syntheticPool.mjs';

const QUERIES = {
  benzene: 'c1ccccc1',
  pyridine: 'c1ccncc1',
  flavone: 'O=c1cc(-c2ccccc2)oc2ccccc12',
  steroid: 'C1CCC2C(C1)CCC1C2CCC2CCCC12',
  quercetin: 'O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12',
  dibenzoselenophene: 'c1ccc2c(c1)[se]c1ccccc12',
  cubane: 'C12C3C4C1C5C2C3C45',
  'biphenyl-F': 'Fc1ccc(-c2ccccc2)cc1',
  'sulfonamide-aryl': 'NS(=O)(=O)c1ccccc1',
};
const SHAPES = (process.env.SHAPES ?? 'p24,p96,full').split(',');
const ONLY = process.env.QUERIES?.split(',');

const variants =
  process.argv[2] === 'synthetic'
    ? syntheticVariants(Number(process.argv[3] ?? 200_000))
    : fileVariants(process.argv.slice(2));

for (const [name, smiles] of Object.entries(QUERIES)) {
  if (ONLY && !ONLY.includes(name)) continue;
  for (const shape of SHAPES) {
    const options =
      shape === 'full'
        ? { mode: 'substructure', timeoutMs: 3_600_000 }
        : {
            mode: 'substructure',
            maxResults: Number(shape.slice(1)),
            limit: Number(shape.slice(1)),
            timeoutMs: 10_000,
          };
    // eslint-disable-next-line no-await-in-loop -- one suite at a time, so they do not compete
    await measure(`${name} ${shape}`, smiles, options);
  }
}
for (const { molDB } of variants) await molDB.close();

async function measure(label, smiles, options) {
  const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
  const answers = new Map();
  const suite = new Benchmark.Suite();
  for (const { name, molDB } of variants) {
    suite.add(name, {
      defer: true,
      minSamples: 30,
      fn(deferred) {
        molDB
          .search(idCode, { ...options, format: 'idCode' })
          .then((response) => {
            answers.set(
              name,
              `${response.total} ${response.results
                .slice(0, 4)
                .map((hit) => hit.entryId)
                .join(',')}`,
            );
            deferred.resolve();
          });
      },
    });
  }
  await new Promise((resolve) => {
    suite
      .on('cycle', (event) => {
        const { name, stats } = event.target;
        console.log(
          `${label.padEnd(26)} ${name.padEnd(10)} ${(stats.mean * 1000).toFixed(1).padStart(9)} ms ±${stats.rme.toFixed(1).padStart(4)}%  ${answers.get(name)}`,
        );
      })
      .on('complete', resolve)
      .run({ async: true });
  });
}

function fileVariants([unfolded, folded, entries, more]) {
  const open = (name, file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA cache_size = -131072');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA mmap_size = 2147483648');
    db.exec(`ATTACH DATABASE '${entries}' AS mol`);
    const molDB = new MoleculesDBSQLite(db, OCL, {
      entriesTable: 'mol.molecules',
      pkColumn: 'id',
      idCodeColumn: 'idCode',
      poolSize: 6,
      searchCacheSize: 0,
    });
    console.log(`${name.padEnd(10)} ${JSON.stringify(molDB.planeStatus())}`);
    return { name, molDB };
  };
  return [
    open('unfolded', unfolded),
    open('folded', folded),
    ...(more ? [open('pending', more)] : []),
  ];
}

function syntheticVariants(rows) {
  const library = syntheticPool();
  const { random } = new XSadd(2026);
  const picks = Array.from({ length: rows + rows / 20 }, () => {
    return library[Math.floor(random() * library.length)];
  });
  const fileOf = (name) => {
    const file = `/tmp/firstPages-${name}.sqlite`;
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${file}${suffix}`, { force: true });
    }
    return file;
  };
  const append = (db, from, to) => {
    const entry = db.prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)');
    const index = db.prepare(
      `INSERT INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2,
         ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    db.exec('BEGIN');
    for (let i = from; i < to; i++) {
      entry.run(i + 1, picks[i].idCode);
      index.run(picks[i].mw, i + 1, ...packSSIndex(picks[i].index));
    }
    db.exec('COMMIT');
  };
  const config = { entriesTable: 'molecules', poolSize: 1, searchCacheSize: 0 };
  const base = fileOf('unfolded');
  {
    const db = new DatabaseSync(base);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)');
    new MoleculesDBSQLite(db, OCL, config).migrate();
    append(db, 0, rows);
    db.close();
  }
  const make = (name, pending) => {
    const file = fileOf(name);
    copyFileSync(base, file);
    const db = new DatabaseSync(file);
    new MoleculesDBSQLite(db, OCL, config).foldPlanes();
    append(db, rows, rows + pending);
    return { name, molDB: new MoleculesDBSQLite(db, OCL, config) };
  };
  const all = [
    {
      name: 'unfolded',
      molDB: new MoleculesDBSQLite(new DatabaseSync(base), OCL, config),
    },
    make('folded', 0),
    make('pending', rows / 20),
  ];
  for (const { name, molDB } of all) {
    console.log(`${name.padEnd(10)} ${JSON.stringify(molDB.planeStatus())}`);
  }
  return all;
}
