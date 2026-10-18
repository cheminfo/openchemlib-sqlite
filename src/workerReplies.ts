/**
 * Whether a message from one of the library's worker threads is a reply of its own protocol: an
 * object whose `key` holds one of `values` (any value when `values` is omitted). A worker's parent
 * also hears messages that are not the library's — under `node --watch`, Node posts
 * `{ 'watch:import': [...] }` from every worker thread as it loads modules — and must ignore them.
 * @param message - What the worker posted.
 * @param key - The field the protocol always sets.
 * @param values - The values that field takes.
 * @returns True for a reply of the protocol.
 */
export function isReply(
  message: unknown,
  key: string,
  values?: ReadonlySet<unknown>,
): message is Record<string, unknown> {
  if (typeof message !== 'object' || message === null) return false;
  const value = (message as Record<string, unknown>)[key];
  return values === undefined ? value !== undefined : values.has(value);
}
