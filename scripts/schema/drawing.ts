import type { Box, Place } from './layout.ts';
import { CHAR, LEFT, bottomOver, layOutGroup } from './layout.ts';
import type { Schema } from './parseSchema.ts';

const TEAL = '#0f766e';
const AMBER = '#b45309';
const SLATE = '#5b6875';

/**
 * Where a store's tables go: the molecule, then its fingerprints and their
 * counts, then the bookkeeping. The boxes of a column stack in this order.
 */
export const STORE_PLACES = new Map<string, Place>([
  ['ocl_molecule', { x: 40, y: 0, tint: TEAL }],
  ['ocl_tile', { x: 420, y: 0, tint: TEAL }],
  ['ocl_bits', { x: 420, y: 0, tint: SLATE }],
  ['ocl_meta', { x: 700, y: 0, tint: SLATE }],
]);

/**
 * Where a rebuild's tables go: the logs of what writers changed, and the next
 * tiles and counts right under the store's own, which they replace.
 */
export const REBUILD_PLACES = new Map<string, Place>([
  ['ocl_rebuild_tiles', { x: 40, y: 0, tint: SLATE }],
  ['ocl_tile_next', { x: 420, y: 0, tint: AMBER }],
  ['ocl_bits_next', { x: 420, y: 0, tint: AMBER }],
]);

/** Where a migration's tables go: the ids the entries got, then the log of their changes. */
export const MIGRATION_PLACES = new Map<string, Place>([
  ['ocl_v5_ids', { x: 40, y: 0, tint: TEAL }],
  ['ocl_v5_changes', { x: 420, y: 0, tint: SLATE }],
]);

/** The title, at the top of the drawing. */
export const TITLE = 'openchemlib-sqlite — the tables it writes';

/** The legend, under the title. */
export const LEGEND =
  'Drawn by npm run schema-svg. PK primary key · FK foreign key · NN not null · dotted frame: only during a rebuild or a migration.';

/** The top of the first frame. */
const FIRST_TOP = 92;
/** The space between two frames. */
const FRAME_GAP = 36;
/** The baseline of a frame's heading, below its top. */
export const HEADING_BASELINE = 30;
/** The baseline of the first note, below the top of its frame. */
export const NOTES_BASELINE = 54;
/** The space between two lines of notes, or of triggers. */
export const LINE = 20;

/** What is drawn: what a store, a rebuild and a migration create, each as SQLite keeps it. */
export interface SchemaDrawing {
  /** The tables `MoleculeStore.open()` creates in the application's file. */
  store: Schema;
  /** The tables a rebuild keeps beside them until its switch. */
  rebuild: Schema;
  /** The tables a migration from 5.x adds, and its triggers on the application's table. */
  migration: Schema;
  /** The file format, from `FORMAT`. */
  format: string;
}

/** What a frame holds, before it is laid out. */
export interface FrameContent {
  heading: string;
  /** The lines under the heading. */
  notes: string[];
  schema: Schema;
  places: ReadonlyMap<string, Place>;
  /** Whether its tables exist only for a while: its frame is dotted. */
  transient: boolean;
}

/** One frame, laid out. */
export interface GroupLayout {
  heading: string;
  notes: string[];
  transient: boolean;
  /** The top of its frame. */
  top: number;
  /** The bottom of its frame. */
  bottom: number;
  boxes: Map<string, Box>;
  /** Its triggers, listed under its boxes: the heading's baseline is 16 below `y`, the first line's 40. */
  triggers: { lines: string[]; x: number; y: number };
}

/** The drawing, laid out. */
export interface DrawingLayout {
  width: number;
  height: number;
  groups: GroupLayout[];
}

/**
 * The frames of the drawing: the store, a rebuild under way, a migration from 5.x.
 * @param drawing - the schemas and the file format
 * @returns what each frame holds, in order
 */
export function framesOf(drawing: SchemaDrawing): FrameContent[] {
  const { store, rebuild, migration, format } = drawing;
  return [
    {
      heading:
        'The store — in the application’s database file, created by MoleculeStore.open()',
      notes: [
        `File format ${format}. Created, checked and written only by the library; the application keys its own rows by ocl_molecule.id.`,
        'Computed from the idCode alone: id = atomCount·2^36 + seq (arrival order, never reused, at most 2^32 − 1), and the three hashes.',
        'ocl_tile: up to 32 molecules of one atom count and 1 Da band as 1,536 bit planes (FragFp, screen, function keys); id = (atoms·2^16 + band)·2^21 + n.',
        'Its function planes are stored sparsely: a 512-bit mask, then the non-zero words. ocl_bits: how many molecules hold each of the 1,536 keys.',
        'ocl_meta: format, stamp, signatures, generation, the last seq, the molecule and distinct-hash counts; where a rebuild or a migration is.',
      ],
      schema: store,
      places: STORE_PLACES,
      transient: false,
    },
    {
      heading:
        'While a rebuild runs — beside the store’s tables, gone once it switches',
      notes: [
        'MoleculeStore.rebuild() builds new tiles and counts here when the keys change; writers go on and log what they touch.',
        'The switch, under one write lock, renames ocl_tile to ocl_tile_old and ocl_tile_next to ocl_tile, and copies the rebuilt counts into ocl_bits.',
        'It drops ocl_bits_next and the log; ocl_tile_old is then freed a thousand rows per transaction.',
        'A file without idCode hashes gets ocl_molecule.idCodeHash and its index, filled a step at a time.',
      ],
      schema: rebuild,
      places: REBUILD_PLACES,
      transient: true,
    },
    {
      heading:
        'While migrating from 5.x — beside the 5.x tables, until dropV5Tables()',
      notes: [
        'migrateFromV5() converts every entry of the application’s table (here `entries`) while 5.x keeps serving it.',
        'ocl_v5_ids: the id each entry got, or why it got none, for the application to re-key its rows.',
        'The triggers log what 5.x writes meanwhile; the end converts those entries again, then drops them with the log.',
      ],
      schema: migration,
      places: MIGRATION_PLACES,
      transient: true,
    },
  ];
}

/**
 * Lay the frames out, one under the other.
 * @param frames - what each frame holds
 * @returns where everything goes
 */
export function layOutDrawing(frames: readonly FrameContent[]): DrawingLayout {
  const groups: GroupLayout[] = [];
  let top = FIRST_TOP;
  for (const frame of frames) {
    const group = layOutFrame(frame, top);
    groups.push(group);
    top = group.bottom + FRAME_GAP;
  }

  let right = LEFT + Math.max(LEGEND.length, TITLE.length) * CHAR;
  for (const group of groups) {
    for (const box of group.boxes.values()) {
      right = Math.max(right, box.x + box.width);
    }
    for (const line of [...group.notes, ...group.triggers.lines]) {
      right = Math.max(right, LEFT + line.length * CHAR);
    }
  }
  return {
    width: Math.ceil((right + 40) / 10) * 10,
    height: (groups.at(-1)?.bottom ?? FIRST_TOP) + 24,
    groups,
  };
}

/**
 * Lay one frame out: its heading and notes, its boxes, and its triggers under them.
 * @param content - what the frame holds
 * @param top - the top of the frame
 * @returns the frame, laid out
 */
function layOutFrame(content: FrameContent, top: number): GroupLayout {
  const { heading, notes, schema, places, transient } = content;
  const boxesTop = top + NOTES_BASELINE + (notes.length - 1) * LINE + 30;
  const boxes = layOutGroup(schema, places, {
    top: boxesTop,
    right: 1200,
    tint: SLATE,
  });
  const boxesBottom = bottomOver(
    boxes.values(),
    0,
    Number.POSITIVE_INFINITY,
    boxesTop,
  );
  const count = schema.triggers.length;
  const triggersTop = boxesBottom + 12;
  const bottom =
    count === 0 ? boxesBottom : triggersTop + 40 + (count - 1) * LINE + 8;
  return {
    heading,
    notes,
    transient,
    top,
    bottom: bottom + 28,
    boxes,
    triggers: { lines: schema.triggers, x: LEFT, y: triggersTop },
  };
}
