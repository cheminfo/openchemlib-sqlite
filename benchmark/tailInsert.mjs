// A/B: insert throughput with version 5's tail, against version 6's watermark triggers.
//
// Version 5 copied every inserted fingerprint into `ocl_ss_tail` through a trigger, so each insert
// wrote two clustered rows and two index entries. Version 6 keeps no copy: two triggers compare the
// entry id with the watermark, and an id above it — ids that only grow — writes nothing more.
//
// Both schemas are written out in this file, so the comparison runs in one process, on the same
// rows, whichever version of the library is checked out. Each variant fills its own file; every
// operation inserts one batch of increasing ids in a transaction, the way a bulk load does.
//
//   node benchmark/tailInsert.mjs [batch]
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import { XSadd } from 'ml-xsadd';
import * as OCL from 'openchemlib';

const BATCH = Number(process.argv[2] ?? 1000);
const WORDS = [0, 1, 2, 3, 4, 5, 6, 7].map((word) => `ss_index${word}`);
const COLUMNS = `mw, entry_id, ${WORDS.join(', ')}`;
const INDEX_SQL = `
CREATE TABLE ocl_ss_index (
  mw REAL NOT NULL, entry_id INTEGER NOT NULL,
  ${WORDS.map((word) => `${word} INTEGER NOT NULL DEFAULT 0`).join(',\n  ')},
  PRIMARY KEY (mw, entry_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_ocl_ss_entry ON ocl_ss_index (entry_id);`;

// --- A: version 5, every insert copied into the tail ---
const TAIL_SQL = `
CREATE TABLE ocl_ss_tail (
  mw REAL NOT NULL, entry_id INTEGER NOT NULL,
  ${WORDS.map((word) => `${word} INTEGER NOT NULL DEFAULT 0`).join(',\n  ')},
  PRIMARY KEY (mw, entry_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_ocl_ss_tail_entry ON ocl_ss_tail (entry_id);
CREATE TRIGGER ocl_ss_tail_insert AFTER INSERT ON ocl_ss_index
BEGIN
  INSERT OR REPLACE INTO ocl_ss_tail (${COLUMNS})
  VALUES (NEW.mw, NEW.entry_id, ${WORDS.map((word) => `NEW.${word}`).join(', ')});
END;`;

// --- B: version 6, the watermark triggers ---
const same = (a, b) => WORDS.map((word) => `${a}.${word} = ${b}.${word}`).join(' AND ');
const bound = '(SELECT bound FROM ocl_ss_fold WHERE id = 1)';
const lower = (id) => `UPDATE ocl_ss_fold
  SET watermark = MIN(watermark, ${id} - 1), bound = MIN(bound, ${id} - 1)
  WHERE id = 1 AND ${id} <= bound;`;
const WATERMARK_SQL = `
CREATE TABLE ocl_ss_slot (slot INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_ocl_ss_slot_entry ON ocl_ss_slot (entry_id);
CREATE TABLE ocl_ss_fold (
  id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER, bound INTEGER,
  cursor_mw REAL, cursor_entry_id INTEGER, segment INTEGER
);
INSERT INTO ocl_ss_fold (id) VALUES (1);
CREATE TRIGGER ocl_ss_watermark_insert AFTER INSERT ON ocl_ss_index
WHEN NEW.entry_id <= ${bound}
  AND NOT EXISTS (SELECT 1 FROM ocl_ss_slot WHERE entry_id = NEW.entry_id)
BEGIN ${lower('NEW.entry_id')} END;
CREATE TRIGGER ocl_ss_watermark_replace BEFORE INSERT ON ocl_ss_index
WHEN NEW.entry_id <= ${bound}
  AND EXISTS (SELECT 1 FROM ocl_ss_index o
               WHERE o.entry_id = NEW.entry_id AND NOT (${same('o', 'NEW')}))
BEGIN ${lower('NEW.entry_id')} END;
CREATE TRIGGER ocl_ss_watermark_update AFTER UPDATE ON ocl_ss_index
WHEN OLD.entry_id <> NEW.entry_id OR NOT (${same('OLD', 'NEW')})
BEGIN
  ${lower('MIN(OLD.entry_id, NEW.entry_id)')}
  DELETE FROM ocl_ss_slot WHERE entry_id = OLD.entry_id AND OLD.entry_id <> NEW.entry_id;
END;
CREATE TRIGGER ocl_ss_watermark_delete AFTER DELETE ON ocl_ss_index
BEGIN DELETE FROM ocl_ss_slot WHERE entry_id = OLD.entry_id; END;`;

// Real fingerprints and weights, drawn at random so the clustered key is written all over.
const pool = [];
for (const ring of ['c1ccccc1', 'c1ccncc1', 'C1CCCCC1', 'c1ccsc1', 'C1CCNCC1']) {
  for (const sub of ['', 'C', 'O', 'N', 'Cl', 'C(=O)O', 'S(=O)(=O)N', 'C#N', 'CCO']) {
    for (const tail of ['', 'c1ccccc1', 'C(F)(F)F', 'OC', 'NC(=O)C']) {
      const mol = OCL.Molecule.fromSmiles(`${sub}${ring}${tail}`);
      pool.push({
        mw: mol.getMolecularFormula().relativeWeight,
        words: Array.from(new BigInt64Array(new Int32Array(mol.getIndex()).buffer)),
      });
    }
  }
}
const { random } = new XSadd(2026);

function open(name, schema, watermark) {
  const file = `/tmp/tailInsert-${name}.sqlite`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA cache_size = -131072');
  db.exec(INDEX_SQL + schema);
  if (watermark !== undefined) {
    db.prepare('UPDATE ocl_ss_fold SET watermark = ?, bound = ? WHERE id = 1').run(watermark, watermark);
  }
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ocl_ss_index (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let next = 1;
  return {
    db,
    run() {
      db.exec('BEGIN');
      for (let i = 0; i < BATCH; i++) {
        const entry = pool[Math.floor(random() * pool.length)];
        insert.run(entry.mw, next++, ...entry.words);
      }
      db.exec('COMMIT');
    },
    rows: () => next - 1,
  };
}

const variants = {
  'v5 tail (5.2.0)': open('tail', TAIL_SQL),
  'v6 never folded': open('never', WATERMARK_SQL),
  'v6 folded, ids above the watermark': open('folded', WATERMARK_SQL, 0),
  'no trigger at all': open('none', ''),
};

const suite = new Benchmark.Suite();
for (const [name, variant] of Object.entries(variants)) {
  suite.add(name, () => variant.run(), { minSamples: 30 });
}
suite
  .on('cycle', (event) => {
    const { name, hz, stats } = event.target;
    const variant = variants[name];
    const tail = variant.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'ocl_ss_tail'")
      .get().n
      ? variant.db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_tail').get().n
      : 0;
    console.log(
      `${name.padEnd(36)} ${(hz * BATCH).toFixed(0).padStart(8)} rows/s  ` +
        `${(1e9 / (hz * BATCH)).toFixed(0).padStart(6)} ns/row  ±${stats.rme.toFixed(1)}%  ` +
        `(${variant.rows()} rows written, ${tail} copied to the tail)`,
    );
  })
  .run();
