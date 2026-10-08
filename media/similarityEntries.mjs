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
// threshold. A is the scan as the library ran it, written out here; B is the library's own
// `scanSimilarity()`, which scans the index alone, then reads the entries of the matches, best
// first. Both use the library's coefficient function, deadline guard and bit-count window, and
// must return the same entries with the same coefficients.
import { DatabaseSync } from 'node:sqlite';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

import { indexBits } from '../src/utils/fingerprintBits.ts';
import {
  installScanDeadline,
  scanDeadlineGuard,
} from '../src/utils/scanDeadline.ts';
import { restrictEntries } from '../src/utils/restrictEntries.ts';
import { bitWindow, scanSimilarity } from '../src/utils/similarityScan.ts';
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
const BOUND = ' AND s.col_rotatableBondCount <= ?';
const THRESHOLD = 0.8;

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
  const restriction = restrictEntries(
    PK,
    false,
    undefined,
    undefined,
    bound
      ? { conditions: ['s.col_rotatableBondCount <= ?'], values: [4] }
      : undefined,
  );
  for (const [name, smiles] of Object.entries(QUERIES)) {
    const query = OCL.Molecule.fromSmiles(smiles).getIndex();
    const { low, high } = bitWindow(indexBits(query), THRESHOLD);
    const answers = new Map();
    const variants = {
      'A entries joined to every row': () =>
        withTanimotoQuery(query, (key) =>
          joined.all(
            key,
            Date.now() + 3_600_000,
            low,
            high,
            ...(bound ? [4] : []),
            THRESHOLD,
          ),
        ).map((row) => ({
          entryId: row.entry_id,
          idCode: row.id_code,
          similarity: row.similarity,
        })),
      'B index alone, entries of the matches': () =>
        scanSimilarity({
          db,
          ocl: OCL,
          entriesTable: TABLE,
          pkColumn: PK,
          idCodeColumn: ID_CODE,
          queryIndex: query,
          threshold: THRESHOLD,
          timeoutMs: 3_600_000,
          restriction,
        }).results,
    };
    const suite = new Benchmark.Suite();
    for (const [label, scan] of Object.entries(variants)) {
      suite.add(label, {
        minSamples: 30,
        fn() {
          const hits = scan();
          let sum = 0;
          for (const hit of hits) sum += hit.entryId * hit.similarity;
          answers.set(
            label,
            `${hits.length} hits, checksum ${sum.toFixed(6)}, idCodes ${hits.reduce((n, hit) => n + hit.idCode.length, 0)} chars`,
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
