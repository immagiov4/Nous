import { AsyncLocalStorage } from 'node:async_hooks';
import * as z from 'zod';

const ModelCallPhaseSchema = z.enum([
  'initializing',
  'awaiting-ack',
  'awaiting-output',
  'receiving-output',
  'completed',
  'post-processing',
]);
type ModelCallPhase = z.infer<typeof ModelCallPhaseSchema>;
const DurationSchema = z.number().nonnegative();
export const ModelCallDiagnosticSchema = z.object({
  phase: ModelCallPhaseSchema,
  elapsedMs: DurationSchema,
  phaseElapsedMs: DurationSchema,
  durationsMs: z.partialRecord(ModelCallPhaseSchema, DurationSchema),
});
type ModelCallDiagnostic = z.infer<typeof ModelCallDiagnosticSchema>;
interface ModelCallObservation {
  mark(phase: ModelCallPhase): void;
  snapshot(): ModelCallDiagnostic;
}
const calls = new AsyncLocalStorage<ModelCallObservation>();
const attempts = new AsyncLocalStorage<(call: ModelCallObservation) => void>();
const errors = new WeakMap<object, ModelCallDiagnostic>();

export const modelCallErrorDiagnostic = (error: object): ModelCallDiagnostic | undefined =>
  errors.get(error);
export const markModelCallPhase = (phase: ModelCallPhase): void => calls.getStore()?.mark(phase);

/** Bind event callbacks to their call rather than the transport's creation context. */
export const bindModelCallPhase = () => {
  const call = calls.getStore();
  return (phase: ModelCallPhase): void => call?.mark(phase);
};

/** Retains only the latest call, scoped to one attempt; no request or output content. */
export const createModelCallObserver = () => {
  let latest: ModelCallObservation | undefined;
  return {
    run: <T>(operation: () => T): T =>
      attempts.run(call => {
        latest = call;
      }, operation),
    snapshot: () => latest?.snapshot(),
  };
};

/** Nested adapters share the call; concurrent calls have independent phase state. */
export const withModelCallDiagnostics = async <T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> => {
  if (calls.getStore()) return operation();
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  let phase: ModelCallPhase = 'initializing';
  let stoppedAt: number | undefined;
  const durationsMs: Partial<Record<ModelCallPhase, number>> = {};
  const stop = () => {
    stoppedAt ??= performance.now();
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const observation: ModelCallObservation = {
    mark(next) {
      // Notifications can arrive before the acknowledgement response.
      if (
        stoppedAt !== undefined ||
        ModelCallPhaseSchema.options.indexOf(next) <= ModelCallPhaseSchema.options.indexOf(phase)
      )
        return;
      const now = performance.now();
      durationsMs[phase] = (durationsMs[phase] ?? 0) + Math.max(0, now - phaseStartedAt);
      phase = next;
      phaseStartedAt = now;
    },
    snapshot() {
      const now = stoppedAt ?? performance.now();
      const phaseElapsedMs = Math.max(0, now - phaseStartedAt);
      return {
        phase,
        elapsedMs: Math.max(0, now - startedAt),
        phaseElapsedMs,
        durationsMs: { ...durationsMs, [phase]: (durationsMs[phase] ?? 0) + phaseElapsedMs },
      };
    },
  };
  attempts.getStore()?.(observation);
  try {
    return await calls.run(observation, operation);
  } catch (error) {
    if (typeof error === 'object' && error !== null) errors.set(error, observation.snapshot());
    throw error;
  } finally {
    stop();
    signal?.removeEventListener('abort', stop);
  }
};
