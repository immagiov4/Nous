/** Process-local admission and file readers for the supported single backend replica. */
export class LibraryExportCoordinator {
  private readonly scheduled = new Set<string>();
  private readonly executing = new Set<Promise<void>>();
  private readonly pending: Array<{ id: string; execute: () => Promise<void> }> = [];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly readers = new Map<string, number>();
  private stopped = false;

  constructor(private readonly capacity: number) {}

  owns(runId: string): boolean {
    return this.scheduled.has(runId);
  }

  hasReaders(runId: string): boolean {
    return this.readers.has(runId);
  }

  /** Hold a reader before asynchronous token validation; release only after the response ends. */
  acquireReader(runId: string): () => void {
    this.readers.set(runId, (this.readers.get(runId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.readers.get(runId);
      if (count === undefined) throw new Error('Library export reader count is inconsistent.');
      const remaining = count - 1;
      if (remaining === 0) this.readers.delete(runId);
      else this.readers.set(runId, remaining);
    };
  }

  /** Serialize short state transitions, never the complete export or HTTP transfer. */
  async exclusively<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const released = Promise.withResolvers<void>();
    const current = previous.then(() => released.promise);
    this.locks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      released.resolve();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  schedule(runId: string, execute: () => Promise<void>): void {
    if (this.stopped) throw new Error('Library export admission is closed.');
    if (this.scheduled.has(runId)) return;
    this.scheduled.add(runId);
    this.pending.push({ id: runId, execute });
    this.drain();
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pending.splice(0)) this.scheduled.delete(pending.id);
    await Promise.allSettled(this.executing);
  }

  private drain(): void {
    while (!this.stopped && this.executing.size < this.capacity && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) throw new Error('Library export admission queue is inconsistent.');
      const execution = Promise.resolve()
        .then(next.execute)
        .finally(() => {
          this.scheduled.delete(next.id);
          this.executing.delete(execution);
          this.drain();
        });
      this.executing.add(execution);
    }
  }
}
