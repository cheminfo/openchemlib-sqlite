import type { MoleculeIndexOptions } from '../indexOptions.ts';
import type { LoadedImage } from '../load/loadImage.ts';
import { loadImage } from '../load/loadImage.ts';
import type { NormalizedSpec } from '../spec.ts';

import { positionOfImage } from './imagePosition.ts';
import { restoreSnapshot } from './restoreSnapshot.ts';
import { saveSnapshot } from './saveSnapshot.ts';
import { removeStaleSaves } from './staleSaves.ts';

/**
 * The image to open an index with: read back from the snapshot when there is a usable one, loaded
 * from the store's tables otherwise, and then saved to the snapshot for the next open.
 * @param file - The database.
 * @param spec - The application's specification.
 * @param options - The index's settled options.
 * @returns The image, before any tail follows it.
 */
export async function openImage(
  file: string,
  spec: NormalizedSpec,
  options: Required<MoleculeIndexOptions>,
): Promise<LoadedImage> {
  const listener = options.onProgress;
  const sizes = {
    blockRows: options.blockRows,
    headroomRows: options.headroomRows,
    headroomShare: options.headroomShare,
  };
  if (options.snapshot !== '') {
    await removeStaleSaves(options.snapshot);
    const restored = await restoreSnapshot({
      path: options.snapshot,
      file,
      spec,
      staleShare: options.snapshotStaleShare,
      listener,
    });
    if (restored !== null) return restored;
  }
  const image = await loadImage(file, spec, {
    readers: options.readers,
    ...sizes,
    onProgress: listener,
  });
  // Before the tail starts, which changes the image's buffers as it follows the file.
  if (options.snapshot !== '') {
    const source = { file, spec, layout: image.layout, sizes };
    await saveSnapshot(
      options.snapshot,
      { ...source, position: positionOfImage(image) },
      listener,
    );
  }
  return image;
}
