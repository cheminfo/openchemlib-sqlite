import type { Box } from './layout.ts';
import { HEADER, ROW } from './layout.ts';
import type { SchemaColumn } from './parseSchema.ts';

/** The font of the boxes and of the notes. */
export const MONO = `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12"`;
/** The font of the title and of the headings. */
export const SANS = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`;
/** The colour of a link, and of the flags that point along one. */
export const LINK_COLOR = '#be185d';

/**
 * Draw one box.
 * @param box - the box
 * @returns the SVG for it
 */
export function drawBox(box: Box): string {
  const { table, x, y, width, height, tint, rows, indexLines } = box;
  const dashed = table.kind === 'view' ? ' stroke-dasharray="5 4"' : '';
  const out = [
    `<g>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="#c3cad3"${dashed}/>`,
    `<path d="M${x} ${y + HEADER}V${y + 10}a10 10 0 0 1 10 -10H${x + width - 10}a10 10 0 0 1 10 10V${y + HEADER}Z" fill="${tint}"/>`,
    `<text x="${x + 12}" y="${y + 20}" ${MONO} font-weight="700" fill="#ffffff">${escape(table.name)}${table.kind === 'view' ? '  (view)' : ''}<tspan font-weight="400" fill-opacity="0.85">  ${escape(table.options.join(', '))}</tspan></text>`,
  ];
  for (const [i, row] of rows.entries()) {
    const rowTop = y + HEADER + i * ROW + 6;
    const weight = row.primaryKey ? ' font-weight="700"' : '';
    out.push(
      `<text x="${x + 12}" y="${rowTop + 13}" ${MONO}${weight} fill="#16202c">${escape(row.name)}<tspan fill="#8a96a3">  ${escape(row.type)}</tspan><tspan fill="${row.linked ? LINK_COLOR : '#5b6875'}">  ${escape(row.flags)}</tspan></text>`,
    );
  }
  const indexTop = y + HEADER + rows.length * ROW + 10;
  if (indexLines.length > 0) {
    out.push(
      `<line x1="${x}" x2="${x + width}" y1="${indexTop}" y2="${indexTop}" stroke="#dfe3e8"/>`,
    );
  }
  for (const [i, line] of indexLines.entries()) {
    out.push(
      `<text x="${x + 12}" y="${indexTop + 14 + i * ROW}" ${MONO} fill="#5b6875" xml:space="preserve">${escape(line)}</text>`,
    );
  }
  out.push('</g>');
  return out.join('\n');
}

/** A point of the drawing. */
export interface Point {
  x: number;
  y: number;
}

/** The cubic Bézier a foreign key is drawn along, and the way its arrow points. */
export interface LinkCurve {
  curve: [Point, Point, Point, Point];
  pointing: 'left' | 'right';
}

/**
 * The curve a foreign key is drawn along, from its row to the key it points
 * at: two boxes in one column are joined along their left edges, bulging out,
 * and two boxes side by side from the facing edges.
 * @param from - the box holding the foreign key
 * @param column - the foreign key
 * @param to - the box it points at
 * @returns the curve's four points, and which way its arrow points
 */
export function linkCurve(from: Box, column: SchemaColumn, to: Box): LinkCurve {
  const key =
    to.table.columns.find((candidate) => candidate.primaryKey)?.name ?? 'id';
  const startY = from.rowY.get(column.name) ?? from.y;
  const endY = to.rowY.get(key) ?? to.y;
  if (Math.abs(to.x - from.x) < 50) {
    const x = Math.min(from.x, to.x);
    return {
      curve: [
        { x, y: startY },
        { x: x - 60, y: startY },
        { x: x - 60, y: endY },
        { x, y: endY },
      ],
      pointing: 'right',
    };
  }
  const rightward = to.x > from.x;
  const startX = rightward ? from.x + from.width : from.x;
  const endX = rightward ? to.x : to.x + to.width;
  const bend = rightward ? 40 : -40;
  return {
    curve: [
      { x: startX, y: startY },
      { x: startX + bend, y: startY },
      { x: endX - bend, y: endY },
      { x: endX, y: endY },
    ],
    pointing: rightward ? 'right' : 'left',
  };
}

/**
 * Draw a foreign key, from its row to the key it points at.
 * @param from - the box holding the foreign key
 * @param column - the foreign key
 * @param to - the box it points at
 * @returns the SVG for the line
 */
export function drawLink(from: Box, column: SchemaColumn, to: Box): string {
  const { curve, pointing } = linkCurve(from, column, to);
  const [start, first, second, end] = curve;
  return [
    `<path d="M${start.x} ${start.y}C${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}" fill="none" stroke="${LINK_COLOR}" stroke-width="1.6"/>`,
    ...linkEnds(start.x, start.y, end.x, end.y, pointing),
  ].join('\n');
}

/**
 * Draw what a view reads.
 * @param view - the view's box
 * @param table - the table it reads
 * @returns the SVG for the line
 */
export function drawViewLink(view: Box, table: Box): string {
  const x = view.x + 40;
  return `<path d="M${x} ${table.y + table.height}V${view.y}" stroke="#8a96a3" stroke-width="1.6" stroke-dasharray="5 4"/>`;
}

/**
 * Escape text for an SVG document.
 * @param text - the text
 * @returns it, safe between tags and in an attribute
 */
export function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The two ends of a link: a dot where it leaves, an arrow where it arrives.
 * @param startX - where it leaves
 * @param startY - where it leaves
 * @param endX - where it arrives
 * @param endY - where it arrives
 * @param pointing - which way the arrow points
 * @returns the SVG for both
 */
function linkEnds(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  pointing: 'left' | 'right',
): string[] {
  return [
    `<circle cx="${startX}" cy="${startY}" r="3.5" fill="${LINK_COLOR}"/>`,
    `<path d="M${endX} ${endY}l${pointing === 'right' ? -9 : 9} -5v10Z" fill="${LINK_COLOR}"/>`,
  ];
}
