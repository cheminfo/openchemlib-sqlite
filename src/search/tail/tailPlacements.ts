import { SEQ_SPAN } from '../../chemistry/key.ts';

/**
 * The seqs the tail's polls placed, each with the change log's last id when the poll read them:
 * a change up to that id, to a molecule a poll placed, is in the row the poll placed already.
 */
export class Placements {
  #placements: Array<{ above: number; upTo: number; change: number }> = [];

  /**
   * Notes a poll's placements.
   * @param above - The watermark before the poll.
   * @param upTo - The watermark after it.
   * @param change - The change log's last id the poll read the tables at.
   */
  add(above: number, upTo: number, change: number): void {
    this.#placements.push({ above, upTo, change });
  }

  /**
   * Whether a molecule was placed after a change to it: reading it again would read what the image
   * holds.
   * @param change - The change.
   * @param id - The molecule.
   * @returns True when the change can be skipped.
   */
  hold(change: number, id: number): boolean {
    const seq = id - Math.floor(id / SEQ_SPAN) * SEQ_SPAN;
    for (const placement of this.#placements) {
      if (
        seq > placement.above &&
        seq <= placement.upTo &&
        change <= placement.change
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Forgets the placements every change of which is applied: they spare no change to come.
   * @param changeId - The last change applied.
   */
  applied(changeId: number): void {
    this.#placements = this.#placements.filter(
      (placement) => placement.change > changeId,
    );
  }
}
