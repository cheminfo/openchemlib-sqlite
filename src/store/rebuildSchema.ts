import { countsTableSql } from './bitCounts.ts';

/** The tiles a rebuild builds beside `ocl_tile`, renamed to it at the switch. */
export const NEXT_TILES_SQL =
  'CREATE TABLE ocl_tile_next (id INTEGER PRIMARY KEY, data BLOB NOT NULL)';

/** The counts a rebuild builds beside `ocl_bits`, copied into it at the switch. */
export const NEXT_COUNTS_SQL: readonly string[] =
  countsTableSql('ocl_bits_next');

/** The tiles writers change while a rebuild runs, in the order they changed them. */
export const CHANGED_TILES_SQL =
  'CREATE TABLE ocl_rebuild_tiles (seq INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL)';

/** Every table a rebuild keeps until its switch, in the order it creates them. */
export const REBUILD_SQL: readonly string[] = [
  NEXT_TILES_SQL,
  ...NEXT_COUNTS_SQL,
  CHANGED_TILES_SQL,
];
