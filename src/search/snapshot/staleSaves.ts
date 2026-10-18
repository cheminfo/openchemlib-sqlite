import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * The file a save of this process writes, then renames over the snapshot once whole.
 * @param path - The snapshot.
 * @returns The temporary file.
 */
export function temporaryOf(path: string): string {
  return `${path}.${process.pid}.tmp`;
}

/**
 * Removes the temporary files that saves cut short left next to a snapshot, each as large as the
 * snapshot: a crash or a kill during a save leaves one. Those of other running processes, which
 * may still be writing them, are kept. This process writes none before it saves, so its own is
 * stale too: a container's process gets the same pid on every start.
 * @param path - The snapshot.
 */
export async function removeStaleSaves(path: string): Promise<void> {
  const directory = dirname(path);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const stale: string[] = [];
  for (const entry of entries) {
    const pid = pidOf(entry, basename(path));
    if (pid === null) continue;
    if (pid === process.pid || !isRunning(pid)) {
      stale.push(join(directory, entry));
    }
  }
  await Promise.all(stale.map((file) => rm(file, { force: true })));
}

function pidOf(entry: string, name: string): number | null {
  if (!entry.startsWith(`${name}.`) || !entry.endsWith('.tmp')) return null;
  const digits = entry.slice(name.length + 1, -'.tmp'.length);
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It runs, under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
