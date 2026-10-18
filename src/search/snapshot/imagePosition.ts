import type { LoadedImage } from '../load/loadImage.ts';
import type { SetEntry } from '../load/plan.ts';
import type { TailCheckpoint } from '../tail/tailState.ts';

/** Where an image stands in its file: what the tail catches up from after it. */
export interface ImagePosition {
  /** Every molecule with a seq up to it is in the image. */
  watermark: number;
  /** The last change applied, null without a change log. */
  changeId: number | null;
  /** The sets its bitmaps hold. */
  sets: SetEntry[];
  /** Per atom count, per band: the first tile the tail reads next. */
  tailFrom: Map<number, Map<number, number>>;
}

/**
 * Where a freshly loaded, or freshly read back, image stands.
 * @param image - The image.
 * @returns Its position.
 */
export function positionOfImage(image: LoadedImage): ImagePosition {
  const tailFrom = new Map<number, Map<number, number>>();
  for (const [s, segment] of image.layout.segments.entries()) {
    const starts = new Map<number, number>();
    for (const [i, band] of segment.bands.entries()) {
      starts.set(band.band, image.tailFrom[s]?.[i] ?? 0);
    }
    tailFrom.set(segment.atoms, starts);
  }
  return {
    watermark: image.layout.watermark,
    changeId: image.plan.changeId,
    sets: image.plan.sets,
    tailFrom,
  };
}

/**
 * Where an image followed by a tail stands, the tail paused.
 * @param checkpoint - The tail's checkpoint.
 * @returns Its position.
 */
export function positionOfCheckpoint(
  checkpoint: TailCheckpoint,
): ImagePosition {
  return {
    watermark: checkpoint.watermark,
    changeId: checkpoint.changeId,
    sets: checkpoint.sets,
    tailFrom: new Map(
      checkpoint.tailFrom.map(([atoms, bands]) => [atoms, new Map(bands)]),
    ),
  };
}
