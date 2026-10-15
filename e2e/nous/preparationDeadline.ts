import { raceOperationWithAbort } from '../../apps/backend/src/workflows/workflowStepAttempt';
import type { FreshnessEvidence } from './freshness';
import type { StackStatus } from './stack';

// Maintainer-approved on 2026-10-13, derived from measured 336 s / 402 s regenerations.
export const FRESH_CONTENT_PREPARATION_TIMEOUT_MS = 20 * 60_000;
export const PREPARATION_TIMEOUT_CODE = 'lesson_generation_preparation_timeout';
export const ACCOUNT_CLEANUP_STEP = 'account-cleanup';

export type PreparationStep = {
  name: string;
  kind: 'operation' | 'cleanup' | 'write';
  status: 'pending' | 'completed' | 'failed' | 'incomplete';
  errorCode?: string;
};

/** One wait budget owns preparation, evidence and cleanup; detached settlements remain observable. */
export class PreparationDeadline {
  private readonly controller = new AbortController();
  private readonly publications = new AbortController();
  private readonly retirement = new AbortController();
  readonly cleanupSignal = this.retirement.signal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly started = performance.now();
  private frozen = false;
  readonly signal = this.controller.signal;
  readonly steps: PreparationStep[] = [];

  constructor(
    readonly evidence: FreshnessEvidence,
    readonly isolated: StackStatus,
    private readonly timeoutError: Error
  ) {
    evidence.preparation = { steps: this.steps, possiblyLeakedResources: [] };
    this.timer = setTimeout(() => {
      evidence.outcome = 'blocked';
      evidence.errorCode = PREPARATION_TIMEOUT_CODE;
      evidence.durationMs = performance.now() - this.started;
      for (const step of this.steps)
        if (step.kind === 'write' && step.status === 'pending') step.status = 'incomplete';
      this.controller.abort(timeoutError);
    }, FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  }

  async step<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
    kind: PreparationStep['kind'] = 'operation',
    detached = false
  ): Promise<T> {
    const entry: PreparationStep = {
      name,
      kind,
      status: this.signal.aborted && kind === 'write' ? 'incomplete' : 'pending',
    };
    this.steps.push(entry);
    // A final immutable file snapshot may finish later, but never holds up an expired outcome.
    let operationSignal = this.signal;
    if (kind === 'cleanup') operationSignal = this.cleanupSignal;
    else if (kind === 'write' && detached && this.signal.aborted)
      operationSignal = this.publications.signal;
    const pending = (async () => {
      if (kind === 'operation' || (kind === 'write' && !detached)) this.signal.throwIfAborted();
      return operation(operationSignal);
    })().then(
      result => {
        if (!this.frozen) entry.status = 'completed';
        return result;
      },
      error => {
        if (!this.frozen) {
          entry.status = kind === 'write' && this.signal.aborted ? 'incomplete' : 'failed';
          entry.errorCode =
            typeof error?.code === 'string' ? error.code : 'preparation_step_failed';
        }
        throw error;
      }
    );
    const settled = await raceOperationWithAbort(() => pending, this.signal);
    if (settled.status === 'aborted' || this.signal.aborted) throw this.timeoutError;
    if (settled.status === 'failed') throw settled.error;
    return settled.value;
  }

  async settle(
    name: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
    kind: 'cleanup' | 'write'
  ): Promise<void> {
    try {
      await this.step(name, operation, kind, true);
    } catch (error) {
      if (!this.signal.aborted) throw error;
    }
  }

  ownConnection(
    connection: { end(options: { timeout: number }): Promise<void> },
    cleanup = false
  ): void {
    const close = () => {
      // Immediate close is resource release, not an additional wait budget.
      void this.step(
        'force-close-connection',
        () => connection.end({ timeout: 0 }),
        'cleanup'
      ).catch(() => {});
    };
    const signal = cleanup ? this.cleanupSignal : this.signal;
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });
  }

  get elapsedMs(): number {
    return performance.now() - this.started;
  }

  finish(): void {
    clearTimeout(this.timer);
    this.evidence.durationMs = performance.now() - this.started;
  }

  freeze(): void {
    this.retirement.abort();
    this.frozen = true;
    const cleanupIncomplete =
      this.steps.some(step => step.name === ACCOUNT_CLEANUP_STEP && step.status !== 'completed') ||
      (this.signal.aborted &&
        !this.steps.some(
          step => step.name === ACCOUNT_CLEANUP_STEP && step.status === 'completed'
        ));
    if (this.evidence.preparation)
      this.evidence.preparation.possiblyLeakedResources = cleanupIncomplete
        ? [{ accountId: this.evidence.userId, projectId: this.evidence.projectId }]
        : [];
  }
}
