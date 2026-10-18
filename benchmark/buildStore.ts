// Builds a benchmark database: the idCodes of a file (one per line) committed through
// MoleculeStore with the test application's rows (tests' order key, filters and sources).
//
//   node benchmark/buildStore.ts <idcodes.txt> <db.sqlite> [threads]
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { APP_SQL, addMolecules } from '../src/__tests__/testDatabase.ts';
import { MoleculeStore } from '../src/index.ts';

const [input, output, threads = '4'] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error(
    'usage: node benchmark/buildStore.ts <idcodes.txt> <db.sqlite> [threads]',
  );
}
const idCodes = readFileSync(input)
  .toString('latin1')
  .split('\n')
  .filter(Boolean);
const db = new DatabaseSync(output);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = OFF');
for (const sql of APP_SQL) db.exec(sql);
const store = await MoleculeStore.open(db, { threads: Number(threads) });
const started = performance.now();
for (let from = 0; from < idCodes.length; from += 10_000) {
  // eslint-disable-next-line no-await-in-loop -- one chunk after the other, with progress
  await addMolecules(db, store, idCodes.slice(from, from + 10_000), {
    seed: from + 1,
  });
  const seconds = (performance.now() - started) / 1000;
  process.stderr.write(
    `${Math.min(from + 10_000, idCodes.length)} molecules, ${seconds.toFixed(0)} s\n`,
  );
}
process.stdout.write(
  `${JSON.stringify({ molecules: store.count(), seconds: (performance.now() - started) / 1000 })}\n`,
);
await store.close();
db.close();
