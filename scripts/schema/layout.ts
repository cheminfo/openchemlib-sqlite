import type { Schema, SchemaColumn, SchemaTable } from './parseSchema.ts';

/** The height of a column's row. */
export const ROW = 19;
/** The height of a box's header. */
export const HEADER = 30;
/**
 * The advance of one character of the 12px monospace font: SF Mono, Menlo and
 * DejaVu Sans Mono all take 7.2px, measured in a browser.
 */
export const CHAR = 7.22;
/** The least space kept between two boxes. */
export const GAP = 30;
/** The left edge of the leftmost boxes. */
export const LEFT = 40;

/** The longest an index line may run before its columns wrap. */
const INDEX_WRAP = 44;

/** Where a table goes, and the colour of its header. */
export interface Place {
  /** Its left edge: the boxes of one column share it. */
  x: number;
  /**
   * Its top, below the top of its group's boxes. A box sits lower when the one
   * above it in its column has grown into that place.
   */
  y: number;
  tint: string;
}

/** Where a group's boxes go. */
export interface GroupArea {
  /** The top of the group's boxes. */
  top: number;
  /** The furthest right a box without a place may reach. */
  right: number;
  /** The colour of the header of a table without a place. */
  tint: string;
}

/** One column of a table, as its row reads. */
export interface Row {
  name: string;
  type: string;
  /** `PK`, `FK→table`, `UQ`, `NN`. */
  flags: string;
  /** Whether a flag points at another table, so is drawn in the link's colour. */
  linked: boolean;
  primaryKey: boolean;
}

/** A box once laid out. */
export interface Box {
  table: SchemaTable;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The colour of its header. */
  tint: string;
  rows: Row[];
  /** The middle of each column's row, by column name. */
  rowY: Map<string, number>;
  /** The index lines, wrapped. */
  indexLines: string[];
}

/**
 * Lay a group of tables out: each where its place says, lower when the box
 * above it has grown into that place, and every table without a place in rows
 * below the others — a table the drawing does not know yet is drawn rather
 * than lost.
 * @param schema - the tables
 * @param places - where each known table goes
 * @param area - where the group's boxes go
 * @returns the boxes, by table name
 */
export function layOutGroup(
  schema: Schema,
  places: ReadonlyMap<string, Place>,
  area: GroupArea,
): Map<string, Box> {
  const { top, right, tint } = area;
  const boxes = new Map<string, Box>();
  const columnBottoms = new Map<number, number>();
  const order = [...places].toSorted(
    ([, first], [, second]) => first.x - second.x || first.y - second.y,
  );
  for (const [name, place] of order) {
    const table = schema.tables.find((candidate) => candidate.name === name);
    if (table === undefined) continue;
    const above = columnBottoms.get(place.x) ?? Number.NEGATIVE_INFINITY;
    const box = layOutBox(
      table,
      place.x,
      Math.max(top + place.y, above + GAP),
      place.tint,
    );
    boxes.set(name, box);
    columnBottoms.set(place.x, box.y + box.height);
  }

  let x = LEFT;
  let y =
    boxes.size === 0
      ? top
      : bottomOver(boxes.values(), 0, Number.POSITIVE_INFINITY, top) + GAP;
  let rowBottom = y;
  for (const table of schema.tables) {
    if (boxes.has(table.name)) continue;
    let box = layOutBox(table, x, y, tint);
    if (x > LEFT && x + box.width > right) {
      x = LEFT;
      y = rowBottom + GAP;
      box = layOutBox(table, x, y, tint);
    }
    boxes.set(table.name, box);
    x += box.width + GAP;
    rowBottom = Math.max(rowBottom, box.y + box.height);
  }
  return boxes;
}

/**
 * The lowest edge of the boxes standing over a span of the drawing.
 * @param boxes - the boxes
 * @param left - the span's left edge
 * @param right - its right edge
 * @param floor - what to answer when no box stands over it
 * @returns the lowest bottom edge
 */
export function bottomOver(
  boxes: Iterable<Box>,
  left: number,
  right: number,
  floor: number,
): number {
  let bottom = floor;
  for (const box of boxes) {
    if (box.x < right && box.x + box.width > left) {
      bottom = Math.max(bottom, box.y + box.height);
    }
  }
  return bottom;
}

/**
 * Size a box and place its rows.
 * @param table - the table or view
 * @param x - its left edge
 * @param y - its top edge
 * @param tint - the colour of its header
 * @returns the box
 */
export function layOutBox(
  table: SchemaTable,
  x: number,
  y: number,
  tint: string,
): Box {
  const rows = table.columns.map((column) => rowOf(column));
  const indexLines = table.indexes.flatMap((index) => wrapIndex(index));
  const lines = [
    headerText(table),
    ...rows.map((row) => `${row.name}  ${row.type}  ${row.flags}`),
    ...indexLines,
  ];
  const width =
    Math.ceil(Math.max(...lines.map((line) => line.length)) * CHAR) + 28;
  const rowY = new Map<string, number>();
  for (const [i, column] of table.columns.entries()) {
    rowY.set(column.name, y + HEADER + (i + 0.5) * ROW + 4);
  }
  const height =
    HEADER +
    (rows.length + indexLines.length) * ROW +
    12 +
    (indexLines.length > 0 ? 6 : 0);
  return { table, x, y, width, height, tint, rows, rowY, indexLines };
}

/**
 * A box's header, as it reads.
 * @param table - the table or view
 * @returns its name, then what is declared on it
 */
export function headerText(table: SchemaTable): string {
  const view = table.kind === 'view' ? '  (view)' : '';
  return `${table.name}${view}  ${table.options.join(', ')}`.trimEnd();
}

/**
 * One column, as its row reads.
 * @param column - the column
 * @returns its name, type and flags
 */
function rowOf(column: SchemaColumn): Row {
  const { name, type, primaryKey, notNull, unique, references } = column;
  const flags = [
    primaryKey ? 'PK' : '',
    references === undefined ? '' : `FK→${references}`,
    unique ? 'UQ' : '',
    notNull && !primaryKey ? 'NN' : '',
  ].filter((flag) => flag !== '');
  return {
    name,
    type,
    flags: flags.join(' '),
    linked: references !== undefined,
    primaryKey,
  };
}

/**
 * One index, over as many lines as its columns need.
 * @param index - the index, as `name (columns)`
 * @returns its lines, the columns indented under the name when they wrap
 */
function wrapIndex(index: string): string[] {
  const line = `idx ${index}`;
  if (line.length <= INDEX_WRAP) return [line];
  const open = index.indexOf('(');
  const lines = [`idx ${index.slice(0, open).trim()}`];
  let current = ' '.repeat(4);
  for (const word of index.slice(open).split(' ')) {
    if (current.length + word.length > INDEX_WRAP && current.trim() !== '') {
      lines.push(current.trimEnd());
      current = ' '.repeat(5);
    }
    current += `${word} `;
  }
  lines.push(current.trimEnd());
  return lines;
}
