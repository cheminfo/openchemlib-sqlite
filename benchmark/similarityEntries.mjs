// A/B: a similarity scan joining the entries table to every row it reads, against the same scan
// reading the fingerprint index alone and the entries table only for the matches.
//
//   node benchmark/similarityEntries.mjs <index.sqlite> <entries.sqlite> [entriesTable] [pk] [idCode]
//
// The entries file is attached as `mol`; the defaults are those of molecules.cheminfo.org, whose
// entries are the `listed_molecules` view over a table of ~400 bytes a row. Written as
// `entries e JOIN ocl_ss_index s`, SQLite scans the entries and looks each one up in
// `idx_ocl_ss_entry`; with the index forced first it walks `idx_ocl_ss_entry` and seeks every row
// of the clustered table from it. Both read every row of the two tables. Read on its own, the
// index is scanned in its stored order, and the entries are read for the few rows that reach the
// threshold. A is the scan as the library ran it; B scans the index alone, then reads the entries
// of the matches, best first, as the library runs it now. Both use the library's coefficient
// function, deadline guard and bit-count window, and must return the same entries with the same
// coefficients. B is written out here so the script runs on a checkout from before it.
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { indexBits } from '../src/utils/fingerprintBits.ts';
import {
  installScanDeadline,
  scanDeadlineGuard,
} from '../src/utils/scanDeadline.ts';
import { bitWindow } from '../src/utils/similarityScan.ts';
import {
  installTanimoto,
  tanimotoSql,
  withTanimotoQuery,
} from '../src/utils/tanimotoFunction.ts';

const [
  INDEX,
  ENTRIES,
  TABLE = 'mol.listed_molecules',
  PK = 'id',
  ID_CODE = 'idCode',
] = process.argv.slice(2);
if (!INDEX || !ENTRIES) {
  throw new Error(
    'usage: similarityEntries.mjs <index.sqlite> <entries.sqlite> [entriesTable] [pk] [idCode]',
  );
}
const QUERIES = {
  quercetin: 'O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12',
  flavone: 'O=c1cc(-c2ccccc2)oc2ccccc12',
};
/** The carried bound of the second round, when the index carries the column. */
const BOUND = ' AND s.col_rotatableBondCount <= 4';
const THRESHOLD = 0.8;
const LOOKUP_CHUNK = 500;

const db = new DatabaseSync(INDEX, { readOnly: true });
db.exec('PRAGMA cache_size = -131072');
db.exec('PRAGMA temp_store = MEMORY');
db.exec('PRAGMA mmap_size = 2147483648');
db.exec(`ATTACH DATABASE '${ENTRIES}' AS mol`);
installTanimoto(db);
installScanDeadline(db);
const rows = db.prepare('SELECT count(*) AS n FROM ocl_ss_index').get().n;
const carriesRotatable = db
  .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
  .get('ocl_ss_index', 'col_rotatableBondCount');
const window = ' AND (s.ss_bits IS NULL OR s.ss_bits BETWEEN ? AND ?)';
const guard = scanDeadlineGuard('s.entry_id');

for (const bound of carriesRotatable ? ['', BOUND] : ['']) {
  const joined = db.prepare(
    `SELECT e.${PK} AS entry_id, e.${ID_CODE} AS id_code, ${tanimotoSql('s')} AS similarity
       FROM ${TABLE} e JOIN ocl_ss_index s ON s.entry_id = e.${PK}
      WHERE ${guard}${window}${bound} AND similarity >= ?`,
  );
  const alone = db.prepare(
    `SELECT s.entry_id AS entry_id, ${tanimotoSql('s')} AS similarity FROM ocl_ss_index s
      WHERE ${guard}${window}${bound} AND similarity >= ?`,
  );
  const lookup = db.prepare(
    `SELECT e.${PK} AS entry_id, e.${ID_CODE} AS id_code
       FROM json_each(?) j CROSS JOIN ${TABLE} e ON e.${PK} = j.value`,
  );
  for (const [name, smiles] of Object.entries(QUERIES)) {
    const query = OCL.Molecule.fromSmiles(smiles).getIndex();
    const { low, high } = bitWindow(indexBits(query), THRESHOLD);
    const answers = new Map();
    const variants = {
      'A entries joined to every row': () =>
        withTanimotoQuery(query, (key) =>
          joined.all(key, Date.now() + 3_600_000, low, high, THRESHOLD),
        ),
      'B index alone, entries of the matches': () => {
        const matches = withTanimotoQuery(query, (key) =>
          alone.all(key, Date.now() + 3_600_000, low, high, THRESHOLD),
        ).toSorted(
          (a, b) => b.similarity - a.similarity || a.entry_id - b.entry_id,
        );
        const idCodes = new Map();
        for (let start = 0; start < matches.length; start += LOOKUP_CHUNK) {
          const ids = [];
          const end = Math.min(start + LOOKUP_CHUNK, matches.length);
          for (let i = start; i < end; i++) ids.push(matches[i].entry_id);
          for (const row of lookup.all(JSON.stringify(ids))) {
            idCodes.set(row.entry_id, row.id_code);
          }
        }
        const found = [];
        for (const match of matches) {
          const idCode = idCodes.get(match.entry_id);
          if (idCode !== undefined) found.push({ ...match, id_code: idCode });
        }
        return found;
      },
    };
    const suite = new Benchmark.Suite();
    for (const [label, scan] of Object.entries(variants)) {
      suite.add(label, {
        minSamples: 30,
        fn() {
          const hits = scan();
          let sum = 0;
          for (const hit of hits) sum += hit.entry_id * hit.similarity;
          answers.set(
            label,
            `${hits.length} hits, checksum ${sum.toFixed(6)}, idCodes ${hits.reduce((n, hit) => n + hit.id_code.length, 0)} chars`,
          );
        },
      });
    }
    suite
      .on('cycle', (event) => {
        const { name: label, stats } = event.target;
        console.log(
          `${name.padEnd(10)} ≥${THRESHOLD}${bound ? ' rot ≤ 4' : ''} ${label.padEnd(38)} ` +
            `${(stats.mean * 1000).toFixed(0).padStart(6)} ms ${((stats.mean * 1e9) / rows).toFixed(0).padStart(5)} ns/row ` +
            `±${stats.rme.toFixed(1)}% (${stats.sample.length} samples)  ${answers.get(label)}`,
        );
      })
      .run();
  }
}
