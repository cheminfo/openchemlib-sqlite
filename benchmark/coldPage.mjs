// A/B: the first page of a search on a cold index, with two builds of the library in one process.
//
//   node benchmark/coldPage.mjs <index.sqlite> <entries.sqlite> <a/lib/index.js> <b/lib/index.js>
//
// Linux only. Every operation drops both files from the page cache (posix_fadvise DONTNEED, through
// python3), opens a connection as molecules.cheminfo.org's readers do (read-only, 128 MB cache,
// 2 GB mmap, the entries attached as `mol` with `molecules (id, idCode)`), and asks one build for a
// first page of 24 with a 10 s budget and one verifier thread — so it pays what the first search of
// a process pays, worker start included, alike for both builds. Each line prints the page's ids.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import Benchmark from 'benchmark';
import * as OCL from 'openchemlib';

const [INDEX, ENTRIES, LIBRARY_A, LIBRARY_B] = process.argv.slice(2);
if (!LIBRARY_B) {
  throw new Error(
    'usage: coldPage.mjs <index.sqlite> <entries.sqlite> <a/lib/index.js> <b/lib/index.js>',
  );
}
const EVICT = `import os, sys
for path in sys.argv[1:]:
    for name in (path, path + "-wal"):
        if os.path.exists(name):
            fd = os.open(name, os.O_RDONLY)
            os.fsync(fd)
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            os.close(fd)`;
const QUERIES = {
  benzene: { smiles: 'c1ccccc1', options: {} },
  'benzene, mw ≥ 610': {
    smiles: 'c1ccccc1',
    options: { mwRange: { min: 610 } },
  },
};
const builds = {
  A: await import(pathToFileURL(LIBRARY_A).href),
  B: await import(pathToFileURL(LIBRARY_B).href),
};

for (const [name, { smiles, options }] of Object.entries(QUERIES)) {
  const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
  const pages = new Map();
  const suite = new Benchmark.Suite();
  for (const [label, build] of Object.entries(builds)) {
    suite.add(label, {
      defer: true,
      minSamples: 30,
      async fn(deferred) {
        spawnSync('python3', ['-c', EVICT, INDEX, ENTRIES]);
        const db = new DatabaseSync(INDEX, { readOnly: true });
        db.exec('PRAGMA cache_size = -131072');
        db.exec('PRAGMA mmap_size = 2147483648');
        db.exec(`ATTACH DATABASE '${ENTRIES}' AS mol`);
        const molDB = new build.MoleculesDBSQLite(db, OCL, {
          entriesTable: 'mol.molecules',
          pkColumn: 'id',
          idCodeColumn: 'idCode',
          poolSize: 1,
          searchCacheSize: 0,
        });
        const response = await molDB.search(idCode, {
          format: 'idCode',
          mode: 'substructure',
          maxResults: 24,
          limit: 24,
          timeoutMs: 10_000,
          ...options,
        });
        pages.set(label, response.results.map((hit) => hit.entryId).join(','));
        await molDB.close();
        db.close();
        deferred.resolve();
      },
    });
  }
  // eslint-disable-next-line no-await-in-loop -- one suite at a time
  await new Promise((resolve) => {
    suite
      .on('cycle', (event) => {
        const { name: label, stats } = event.target;
        console.log(
          `${name.padEnd(18)} ${label} ${(stats.mean * 1000).toFixed(1).padStart(8)} ms ±${stats.rme.toFixed(1)}%  ` +
            `${pages.get(label)?.slice(0, 60)}`,
        );
      })
      .on('complete', resolve)
      .run({ async: true });
  });
}
