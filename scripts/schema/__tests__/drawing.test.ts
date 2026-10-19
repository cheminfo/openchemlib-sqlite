import { expect, test } from 'vitest';

import { FORMAT } from '../../../src/index.ts';
import type { DrawingLayout, SchemaDrawing } from '../drawing.ts';
import { NOTES_BASELINE, framesOf, layOutDrawing } from '../drawing.ts';
import type { Box } from '../layout.ts';
import { LEFT } from '../layout.ts';
import { parseSchema } from '../parseSchema.ts';
import { scratchSchemaSql } from '../schemaSvg.ts';

const sql = await scratchSchemaSql();
const drawing: SchemaDrawing = {
  store: parseSchema(sql.store),
  rebuild: parseSchema(sql.rebuild),
  migration: parseSchema(sql.migration),
  format: FORMAT,
};

/**
 * The pairs of boxes closer than 20px, and the boxes outside their frame.
 * @param layout - the drawing, laid out
 * @returns what is misplaced, by name
 */
function misplacedBoxes(layout: DrawingLayout): string[] {
  const misplaced: string[] = [];
  const boxes = layout.groups.flatMap((group) => [...group.boxes.values()]);
  for (const [i, box] of boxes.entries()) {
    for (const other of boxes.slice(i + 1)) {
      if (closer(box, other, 20)) {
        misplaced.push(`${box.table.name} / ${other.table.name}`);
      }
    }
  }
  for (const group of layout.groups) {
    for (const box of group.boxes.values()) {
      if (
        box.x < LEFT ||
        box.x + box.width > layout.width - LEFT ||
        box.y < group.top + NOTES_BASELINE ||
        box.y + box.height > group.bottom - 20
      ) {
        misplaced.push(`${box.table.name} out of its frame`);
      }
    }
  }
  return misplaced;
}

/**
 * Whether two boxes come closer than a margin.
 * @param first - a box
 * @param second - another
 * @param margin - the least space between them
 * @returns whether they do
 */
function closer(first: Box, second: Box, margin: number): boolean {
  return (
    first.x < second.x + second.width + margin &&
    second.x < first.x + first.width + margin &&
    first.y < second.y + second.height + margin &&
    second.y < first.y + first.height + margin
  );
}

test('the store, a rebuild and a migration are drawn in a frame each, every table in its place', () => {
  const layout = layOutDrawing(framesOf(drawing));

  expect(
    layout.groups.map((group) => ({
      transient: group.transient,
      tables: [...group.boxes.keys()],
    })),
  ).toStrictEqual([
    {
      transient: false,
      tables: ['ocl_molecule', 'ocl_tile', 'ocl_bits', 'ocl_meta'],
    },
    {
      transient: true,
      tables: ['ocl_rebuild_tiles', 'ocl_tile_next', 'ocl_bits_next'],
    },
    { transient: true, tables: ['ocl_v5_ids', 'ocl_v5_changes'] },
  ]);
  expect(misplacedBoxes(layout)).toStrictEqual([]);

  const tile = layout.groups[0]?.boxes.get('ocl_tile');
  const next = layout.groups[1]?.boxes.get('ocl_tile_next');

  expect(next?.x).toBe(tile?.x);
});

test('a table the drawing has no place for yet is drawn under the others', () => {
  const layout = layOutDrawing(
    framesOf({
      ...drawing,
      store: parseSchema(
        `${sql.store}\nCREATE TABLE ocl_future (id INTEGER PRIMARY KEY, weight REAL NOT NULL);`,
      ),
    }),
  );

  const boxes = layout.groups[0]?.boxes ?? new Map<string, Box>();
  const added = boxes.get('ocl_future');
  let lowest = 0;
  for (const box of boxes.values()) {
    if (box !== added) lowest = Math.max(lowest, box.y + box.height);
  }

  expect({ x: added?.x, y: added?.y }).toStrictEqual({
    x: LEFT,
    y: lowest + 30,
  });
  expect(misplacedBoxes(layout)).toStrictEqual([]);
});
