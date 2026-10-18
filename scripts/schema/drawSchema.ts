import {
  MONO,
  SANS,
  drawBox,
  drawLink,
  drawViewLink,
  escape,
} from './drawShapes.ts';
import type { GroupLayout, SchemaDrawing } from './drawing.ts';
import {
  HEADING_BASELINE,
  LEGEND,
  LINE,
  NOTES_BASELINE,
  TITLE,
  framesOf,
  layOutDrawing,
} from './drawing.ts';
import type { Box } from './layout.ts';
import { LEFT } from './layout.ts';

/**
 * Draw the tables the library writes as one SVG document: a frame for the
 * store, one for a rebuild under way, one for a migration from 5.x.
 * @param drawing - the three schemas and the formats
 * @returns the SVG document
 */
export function drawSchema(drawing: SchemaDrawing): string {
  const { width, height, groups } = layOutDrawing(framesOf(drawing));
  const boxes = new Map<string, Box>();
  for (const group of groups) {
    for (const [name, box] of group.boxes) boxes.set(name, box);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escape(TITLE)}</title>`,
    `<rect width="${width}" height="${height}" fill="#f5f7fa"/>`,
    `<text x="${LEFT}" y="44" ${SANS} font-size="22" font-weight="700" fill="#16202c">${escape(TITLE)}</text>`,
    `<text x="${LEFT}" y="68" ${MONO} fill="#5b6875">${escape(LEGEND)}</text>`,
    ...groups.map((group) => drawFrame(group, width)),
    ...drawLinks(boxes),
    ...groups.flatMap((group) => [...group.boxes.values()].map(drawBox)),
    ...groups.flatMap((group) => drawTriggers(group)),
    '</svg>',
    '',
  ].join('\n');
}

/**
 * Draw a frame, its heading and its notes.
 * @param group - the frame
 * @param width - the drawing's width
 * @returns the SVG for it
 */
function drawFrame(group: GroupLayout, width: number): string {
  const { top, bottom, heading, notes, transient } = group;
  const stroke = transient
    ? 'stroke="#8a96a3" stroke-width="2" stroke-dasharray="0.1 6" stroke-linecap="round"'
    : 'stroke="#c3cad3"';
  return [
    `<rect x="20" y="${top}" width="${width - 40}" height="${bottom - top}" rx="16" fill="none" ${stroke}/>`,
    `<text x="${LEFT}" y="${top + HEADING_BASELINE}" ${SANS} font-size="16" font-weight="700" fill="#16202c">${escape(heading)}</text>`,
    ...notes.map(
      (note, i) =>
        `<text x="${LEFT}" y="${top + NOTES_BASELINE + i * LINE}" ${MONO} fill="#5b6875">${escape(note)}</text>`,
    ),
  ].join('\n');
}

/**
 * Draw the foreign keys, and what the views read.
 * @param boxes - every box, by table
 * @returns the SVG for each line
 */
function drawLinks(boxes: ReadonlyMap<string, Box>): string[] {
  const links: string[] = [];
  for (const box of boxes.values()) {
    for (const column of box.table.columns) {
      const target =
        column.references === undefined
          ? undefined
          : boxes.get(column.references);
      if (target !== undefined) links.push(drawLink(box, column, target));
    }
    const read =
      box.table.from === undefined ? undefined : boxes.get(box.table.from);
    if (read !== undefined) links.push(drawViewLink(box, read));
  }
  return links;
}

/**
 * List a frame's triggers under its boxes.
 * @param group - the frame
 * @returns the SVG for the list, nothing when it has none
 */
function drawTriggers(group: GroupLayout): string[] {
  const { lines, x, y } = group.triggers;
  if (lines.length === 0) return [];
  return [
    `<text x="${x}" y="${y + 16}" ${MONO} font-weight="700" fill="#16202c">Triggers</text>`,
    ...lines.map(
      (line, i) =>
        `<text x="${x}" y="${y + 40 + i * LINE}" ${MONO} fill="#5b6875">${escape(line)}</text>`,
    ),
  ];
}
