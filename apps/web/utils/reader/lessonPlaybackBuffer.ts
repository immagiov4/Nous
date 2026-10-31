/** Upcoming listening time requested by the lesson player, in wall-clock seconds. */
export const PLAYBACK_BUFFER_SECONDS = 30;
// Two paid preparations can overlap without issuing a burst for an entire lesson.
export const PLAYBACK_PREPARATION_CONCURRENCY = 2;

/** A cancellable FIFO shared by foreground and prefetched preparations. */
export class PlaybackPreparationQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        this.active++;
        void operation()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.waiting.shift()?.();
          });
      };
      if (signal.aborted) reject(signal.reason);
      else if (this.active < PLAYBACK_PREPARATION_CONCURRENCY) start();
      else {
        signal.addEventListener('abort', abort, { once: true });
        this.waiting.push(start);
      }
    });
  }
}

/** Includes the clip that reaches the buffer horizon; playback speed consumes it faster. */
export function playbackBufferIndexes(
  durations: readonly { duration: number }[],
  current: number,
  speed: number
): number[] {
  const indexes: number[] = [];
  let seconds = 0;
  for (
    let next = current + 1;
    next < durations.length && seconds < PLAYBACK_BUFFER_SECONDS * speed;
    next++
  ) {
    indexes.push(next);
    seconds += durations[next].duration;
  }
  return indexes;
}

/** Stops waiting for obsolete cancellation without interrupting cancellation of the old provider run. */
export async function waitForPlaybackCancellation(
  pending: Promise<void> | undefined,
  signal: AbortSignal,
  timeoutMs?: number
): Promise<void> {
  if (pending === undefined) return;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      signal.removeEventListener('abort', abort);
      globalThis.clearTimeout(timer);
    };
    const abort = () => {
      clean();
      reject(signal.reason);
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : globalThis.setTimeout(() => {
            clean();
            reject(new Error('Playback cancellation wait timed out'));
          }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(
      () => {
        clean();
        resolve();
      },
      error => {
        clean();
        reject(error);
      }
    );
  });
}
