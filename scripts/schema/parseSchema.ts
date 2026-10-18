/** One column of a table or a view. */
export interface SchemaColumn {
  name: string;
  /** The declared type, empty for a view's column. */
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  /** The table a foreign key points at. */
  references?: string;
}

/** A table or a view, with what is declared on it. */
export interface SchemaTable {
  name: string;
  kind: 'table' | 'view';
  /** `STRICT`, `WITHOUT ROWID`. */
  options: string[];
  columns: SchemaColumn[];
  /** Each index on it, written as `name (columns)`. */
  indexes: string[];
  /** For a view, the table it reads. */
  from?: string;
}

/** What a schema declares. */
export interface Schema {
  tables: SchemaTable[];
  /** Each trigger, written as `name: table`. */
  triggers: string[];
}

const IF_NOT_EXISTS = '(?:IF NOT EXISTS )?';
const TRIGGER = new RegExp(
  String.raw`CREATE TRIGGER ${IF_NOT_EXISTS}${identifier('name')} \w+ (?:INSERT|UPDATE|DELETE)(?: OF "?\w+"?(?: ?, ?"?\w+"?)*)? ON ${identifier('table')}.*?\bEND;`,
  'g',
);
const TABLE = new RegExp(
  String.raw`^CREATE TABLE ${IF_NOT_EXISTS}${identifier('name')} \((?<body>.*)\)(?<options>.*)$`,
);
const INDEX = new RegExp(
  String.raw`^CREATE (?<unique>UNIQUE )?INDEX ${IF_NOT_EXISTS}${identifier('name')} ON ${identifier('table')} \((?<columns>[^)]*)\)(?<partial> WHERE .*)?$`,
);
const VIEW = new RegExp(
  `^CREATE VIEW ${IF_NOT_EXISTS}${identifier('name')} AS SELECT (?<columns>.*?) FROM ${identifier('from')}`,
);

/**
 * Read the tables, views, indexes and triggers a schema script declares.
 *
 * Written for `schema.sql` and for the statements SQLite keeps in
 * `sqlite_schema`, rather than for SQL at large: one statement per object, and
 * constraints written on the column they belong to or as a table constraint.
 * @param sql - the schema script, each statement ending with a semicolon
 * @returns what it declares, in the order it declares it
 */
export function parseSchema(sql: string): Schema {
  const text = sql.replaceAll(/--[^\n]*/g, '').replaceAll(/\s+/g, ' ');
  const triggers: string[] = [];
  const withoutTriggers = text.replaceAll(TRIGGER, (...match: unknown[]) => {
    const { name: trigger, table } = match.at(-1) as {
      name: string;
      table: string;
    };
    triggers.push(`${trigger}: ${table}`);
    return '';
  });

  const tables: SchemaTable[] = [];
  const indexes: Array<{ table: string; text: string }> = [];
  for (const statement of withoutTriggers.split(';')) {
    const trimmed = statement.trim();
    const table = TABLE.exec(trimmed)?.groups;
    if (table) {
      tables.push(
        readTable(table.name ?? '', table.body ?? '', table.options ?? ''),
      );
      continue;
    }
    const index = INDEX.exec(trimmed)?.groups;
    if (index) {
      const unique = index.unique === undefined ? '' : 'unique ';
      const partial = index.partial === undefined ? '' : ' partial';
      indexes.push({
        table: index.table ?? '',
        text: `${unique}${index.name} (${index.columns})${partial}`,
      });
      continue;
    }
    const view = VIEW.exec(trimmed)?.groups;
    if (view) {
      tables.push(readView(view.name ?? '', view.columns ?? '', view.from));
    }
  }
  for (const index of indexes) {
    tables
      .find((candidate) => candidate.name === index.table)
      ?.indexes.push(index.text);
  }
  return { tables, triggers };
}

/**
 * Read one CREATE TABLE statement.
 * @param tableName - the table's name
 * @param body - what the parentheses hold
 * @param options - what follows them
 * @returns the table
 */
function readTable(
  tableName: string,
  body: string,
  options: string,
): SchemaTable {
  const columns: SchemaColumn[] = [];
  const indexes: string[] = [];
  const keys: string[] = [];
  const foreignKeys: Array<{ column: string; table: string }> = [];
  for (const part of splitTopLevel(body)) {
    const constraint =
      /^(?<kind>PRIMARY KEY|UNIQUE|FOREIGN KEY) \((?<columns>[^)]*)\)(?: REFERENCES "?(?<table>\w+)"?)?/.exec(
        part,
      )?.groups;
    if (constraint) {
      const listed = (constraint.columns ?? '').split(',').map(unquote);
      if (constraint.kind === 'PRIMARY KEY') keys.push(...listed);
      if (constraint.kind === 'UNIQUE') {
        indexes.push(`unique (${listed.join(', ')})`);
      }
      if (constraint.table !== undefined) {
        foreignKeys.push({ column: listed[0] ?? '', table: constraint.table });
      }
      continue;
    }
    // CHECK and named constraints say nothing the drawing shows.
    if (/^(?:CHECK|CONSTRAINT) /.test(part)) continue;
    const [columnName = '', type = '', ...rest] = part.split(' ');
    const constraints = rest.join(' ');
    columns.push({
      name: unquote(columnName),
      type,
      primaryKey: constraints.includes('PRIMARY KEY'),
      notNull: constraints.includes('NOT NULL'),
      unique: /\bUNIQUE\b/.test(constraints),
      references: /REFERENCES "?(?<table>\w+)/.exec(constraints)?.groups?.table,
    });
  }
  for (const column of columns) {
    if (keys.includes(column.name)) column.primaryKey = true;
    column.references ??= foreignKeys.find(
      (key) => key.column === column.name,
    )?.table;
  }
  return {
    name: tableName,
    kind: 'table',
    options: options
      .split(',')
      .map((option) => option.trim())
      .filter((option) => option !== ''),
    columns,
    indexes,
  };
}

/**
 * Read one CREATE VIEW statement.
 * @param viewName - the view's name
 * @param columns - what it selects
 * @param from - the table it reads
 * @returns the view
 */
function readView(
  viewName: string,
  columns: string,
  from: string | undefined,
): SchemaTable {
  return {
    name: viewName,
    kind: 'view',
    options: [],
    columns: columns.split(',').map((column) => ({
      name: unquote(column),
      type: '',
      primaryKey: false,
      notNull: false,
      unique: false,
    })),
    indexes: [],
    from,
  };
}

/**
 * A name without its quotes.
 * @param text - the name, perhaps double-quoted, perhaps padded
 * @returns the bare name
 */
function unquote(text: string): string {
  return text.trim().replaceAll('"', '');
}

/**
 * Split a list on the commas outside parentheses.
 * @param text - the list
 * @returns its items, trimmed
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * A name, bare or double-quoted: SQLite stores a renamed table's name quoted.
 * @param group - the capture group it is read into
 * @returns the pattern
 */
function identifier(group: string): string {
  return String.raw`"?(?<${group}>\w+)"?`;
}
