import type { DatabaseSync } from 'node:sqlite';

import { hasTable } from './schema.ts';

/** The application's table a 5.x store indexed, as its `MoleculesDBSQLite` was configured. */
export interface V5Entries {
  /** The table (`entriesTable`). */
  table: string;
  /** Its INTEGER PRIMARY KEY (`pkColumn`). */
  key: string;
  /** The column holding each entry's idCode (`idCodeColumn`). */
  idCode: string;
}

/** Where a migration from 5.x is: under way, done, or never started. */
export type V5State = 'migrating' | 'migrated' | '';

/**
 * The id each 5.x entry got, or the reason it got none: what the application re-keys its own rows
 * with, kept until dropV5Tables().
 */
export const V5_IDS_SQL: readonly string[] = [
  'CREATE TABLE ocl_v5_ids (entry INTEGER PRIMARY KEY, id INTEGER, error TEXT)',
  'CREATE INDEX ocl_v5_ids_id ON ocl_v5_ids (id)',
];

/** The entries the 5.x writers changed while the migration ran, in the order they changed them. */
export const V5_CHANGES_SQL =
  'CREATE TABLE ocl_v5_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry INTEGER NOT NULL)';

/** The triggers that log those changes, on the application's table. */
export const V5_TRIGGERS: readonly string[] = [
  'ocl_v5_insert',
  'ocl_v5_update',
  'ocl_v5_delete',
];

/**
 * The statements creating the triggers that log every entry the 5.x writers add, change or remove.
 * @param entries - The application's table.
 * @returns The statements, one per trigger of {@link V5_TRIGGERS}.
 */
export function v5TriggerSql(entries: V5Entries): string[] {
  const table = quoteName(entries.table);
  const key = quoteName(entries.key);
  const idCode = quoteName(entries.idCode);
  const log = 'INSERT INTO ocl_v5_changes (entry)';
  return [
    `CREATE TRIGGER ocl_v5_insert AFTER INSERT ON ${table} BEGIN ${log} VALUES (NEW.${key}); END`,
    `CREATE TRIGGER ocl_v5_update AFTER UPDATE OF ${key}, ${idCode} ON ${table} BEGIN
      ${log} VALUES (OLD.${key});
      ${log} SELECT NEW.${key} WHERE NEW.${key} IS NOT OLD.${key};
    END`,
    `CREATE TRIGGER ocl_v5_delete AFTER DELETE ON ${table} BEGIN ${log} VALUES (OLD.${key}); END`,
  ];
}

/**
 * Whether a table is one openchemlib-sqlite 5.x created: every one of them is named `ocl_ss_*`
 * or `ocl_no_stereo_*`, and no 6.x table is.
 * @param name - The table.
 * @returns True for a 5.x table.
 */
export function isV5Table(name: string): boolean {
  return name.startsWith('ocl_ss_') || name.startsWith('ocl_no_stereo_');
}

/**
 * The 5.x tables a file still holds.
 * @param db - The connection.
 * @returns Their names, in the order SQLite keeps them.
 */
export function v5Tables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid",
    )
    .all() as Array<{ name: string }>;
  const tables: string[] = [];
  for (const { name } of rows) {
    if (isV5Table(name)) tables.push(name);
  }
  return tables;
}

/**
 * Where the file's migration from 5.x is.
 * @param db - The connection.
 * @returns `migrating`, `migrated`, or `''` when none ever started.
 */
export function v5State(db: DatabaseSync): V5State {
  if (!hasTable(db, 'ocl_meta')) return '';
  const row = db
    .prepare("SELECT value FROM ocl_meta WHERE name = 'v5.state'")
    .get() as { value: string } | undefined;
  return (row?.value ?? '') as V5State;
}

/**
 * Refuses a file a 6.x store or index cannot use yet: one holding 5.x tables that no migration
 * converted, or one whose migration is under way.
 * @param db - The connection.
 */
export function refuseV5(db: DatabaseSync): void {
  const state = v5State(db);
  if (state === 'migrating') {
    throw new Error(
      'its migration from openchemlib-sqlite 5.x is under way: end it with migrateFromV5({ entries, finish: true })',
    );
  }
  if (state === '' && v5Tables(db).length > 0) {
    throw new Error(
      'a file of openchemlib-sqlite 5.x, which 6.x does not read: migrate it in place with migrateFromV5() (README, "Migrating from 5.x")',
    );
  }
}

/**
 * Refuses an entries table the migration cannot walk: its key must be its INTEGER PRIMARY KEY,
 * and its idCode column must exist.
 * @param db - The connection.
 * @param entries - The application's table.
 */
export function checkEntries(db: DatabaseSync, entries: V5Entries): void {
  const columns = db
    .prepare(`PRAGMA table_info(${quoteName(entries.table)})`)
    .all() as Array<{ name: string; type: string; pk: number }>;
  if (columns.length === 0) throw new Error(`no table ${entries.table}`);
  const keys = columns.filter((column) => column.pk > 0);
  const key = keys[0];
  if (
    keys.length !== 1 ||
    key?.name !== entries.key ||
    key.type.toUpperCase() !== 'INTEGER'
  ) {
    throw new Error(
      `${entries.table}.${entries.key} is not the table's INTEGER PRIMARY KEY, which the migration walks`,
    );
  }
  if (!columns.some((column) => column.name === entries.idCode)) {
    throw new Error(`${entries.table} has no column ${entries.idCode}`);
  }
}

/**
 * An identifier as SQL reads it, whatever characters it holds.
 * @param name - The table or column.
 * @returns It, double-quoted.
 */
export function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
