/** Reclaim released file buffers in Bun production; the Node test runner uses its own collector. */
export const collectReleasedSourceMemory = (): void => {
  if (typeof Bun !== 'undefined') Bun.gc(true);
};
