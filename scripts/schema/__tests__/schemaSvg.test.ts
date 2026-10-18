import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { parseSchema } from '../parseSchema.ts';
import { schemaSvg, schemaSvgPath, scratchSchemaSql } from '../schemaSvg.ts';

test('the schema drawing is the one this checkout draws', async () => {
  // A table changed without `npm run schema-svg` fails here, so the drawing in
  // the repository never describes another schema.
  expect(readFileSync(schemaSvgPath(), 'utf8')).toBe(await schemaSvg());
});

test('every table a store, a rebuild and a migration create is read, with its indexes', async () => {
  const sql = await scratchSchemaSql();
  const store = parseSchema(sql.store);
  const rebuild = parseSchema(sql.rebuild);
  const migration = parseSchema(sql.migration);

  expect(store.tables.map((table) => table.name)).toStrictEqual([
    'ocl_molecule',
    'ocl_tile',
    'ocl_meta',
    'ocl_bits',
  ]);
  expect(
    store.tables.find((table) => table.name === 'ocl_molecule')?.indexes,
  ).toStrictEqual([
    'ocl_molecule_nostereo (noStereoHash)',
    'ocl_molecule_tautomer (tautomerHash)',
    'ocl_molecule_idcode (idCodeHash)',
  ]);
  expect(rebuild.tables.map((table) => table.name)).toStrictEqual([
    'ocl_tile_next',
    'ocl_bits_next',
    'ocl_rebuild_tiles',
    'ocl_rebuild_removed',
  ]);
  expect(migration.tables.map((table) => table.name)).toStrictEqual([
    'ocl_v5_ids',
    'ocl_v5_changes',
  ]);
  expect(migration.triggers).toStrictEqual([
    'ocl_v5_insert: entries',
    'ocl_v5_update: entries',
    'ocl_v5_delete: entries',
  ]);
  expect([store, rebuild].flatMap((part) => part.triggers)).toStrictEqual([]);
});
