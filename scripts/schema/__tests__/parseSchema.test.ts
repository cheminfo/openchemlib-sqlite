import { expect, test } from 'vitest';

import type { SchemaColumn } from '../parseSchema.ts';
import { parseSchema } from '../parseSchema.ts';

/**
 * A table's column as the parser reads it.
 * @param name - its name
 * @param type - its declared type
 * @param flags - what is declared on it
 * @returns the column
 */
function column(
  name: string,
  type: string,
  flags: Partial<SchemaColumn> = {},
): SchemaColumn {
  return {
    name,
    type,
    primaryKey: false,
    notNull: false,
    unique: false,
    references: undefined,
    ...flags,
  };
}

test('the statements SQLite keeps in sqlite_schema are read', () => {
  // No IF NOT EXISTS, a name quoted by a rename, constraints written as table
  // constraints, an index before its table, a trigger written without IF NOT
  // EXISTS: what `sqlite_schema` holds once a file has been renamed and migrated.
  const schema = parseSchema(`
CREATE UNIQUE INDEX idx_fingerprints_entry
  ON fingerprints (entry_id);
CREATE TABLE "fingerprints" (
  mw        REAL    NOT NULL,
  entry_id  INTEGER NOT NULL,
  PRIMARY KEY (mw, entry_id)
) WITHOUT ROWID;
CREATE TABLE hashes (
  entry_id   INTEGER PRIMARY KEY,
  hash       INTEGER,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (hash, applied_at),
  FOREIGN KEY (hash) REFERENCES "fingerprints" (entry_id),
  CHECK (hash <> 0)
);
CREATE INDEX idx_hashes ON hashes (hash) WHERE hash IS NOT NULL;
CREATE VIEW listed AS SELECT entry_id, "hash" FROM "hashes" WHERE hash > 0;
CREATE TRIGGER fingerprints_append
AFTER INSERT ON fingerprints
BEGIN
  INSERT OR REPLACE INTO hashes (entry_id) VALUES (NEW.entry_id);
END;
`);

  expect(schema).toStrictEqual({
    tables: [
      {
        name: 'fingerprints',
        kind: 'table',
        options: ['WITHOUT ROWID'],
        columns: [
          column('mw', 'REAL', { primaryKey: true, notNull: true }),
          column('entry_id', 'INTEGER', { primaryKey: true, notNull: true }),
        ],
        indexes: ['unique idx_fingerprints_entry (entry_id)'],
      },
      {
        name: 'hashes',
        kind: 'table',
        options: [],
        columns: [
          column('entry_id', 'INTEGER', { primaryKey: true }),
          column('hash', 'INTEGER', { references: 'fingerprints' }),
          column('applied_at', 'TEXT', { notNull: true }),
        ],
        indexes: ['unique (hash, applied_at)', 'idx_hashes (hash) partial'],
      },
      {
        name: 'listed',
        kind: 'view',
        options: [],
        columns: [
          {
            name: 'entry_id',
            type: '',
            primaryKey: false,
            notNull: false,
            unique: false,
          },
          {
            name: 'hash',
            type: '',
            primaryKey: false,
            notNull: false,
            unique: false,
          },
        ],
        indexes: [],
        from: 'hashes',
      },
    ],
    triggers: ['fingerprints_append: fingerprints'],
  });
});
