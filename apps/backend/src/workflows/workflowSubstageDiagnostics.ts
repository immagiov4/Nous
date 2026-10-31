import type { WorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';
import { toWorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';

export type WorkflowSubstageName =
  | 'load-project'
  | 'extract-pdf-images'
  | 'stage-assets'
  | 'caption-images'
  | 'caption-image'
  | 'persist-provider-effect';

export interface WorkflowSubstageDiagnostics {
  run<Output>(name: WorkflowSubstageName, operation: () => Promise<Output>): Promise<Output>;
}

interface SubstageObservation {
  diagnostic?: WorkflowErrorDiagnostic;
  durationMs?: number;
  name: WorkflowSubstageName;
  outcome: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: number;
}

/** Snapshots in-flight work at the runner boundary, even when a dependency ignores abort. */
export const createWorkflowSubstageDiagnostics = (signal: AbortSignal) => {
  const observations: SubstageObservation[] = [];
  let interruptedAt = signal.aborted ? Date.now() : undefined;
  signal.addEventListener(
    'abort',
    () => {
      interruptedAt = Date.now();
    },
    { once: true }
  );
  const durationSince = (startedAt: number) =>
    Math.max(0, (interruptedAt ?? Date.now()) - startedAt);
  return {
    async run<Output>(
      name: WorkflowSubstageName,
      operation: () => Promise<Output>
    ): Promise<Output> {
      const observation: SubstageObservation = { name, outcome: 'running', startedAt: Date.now() };
      observations.push(observation);
      try {
        const output = await operation();
        observation.outcome = signal.aborted ? 'interrupted' : 'succeeded';
        return output;
      } catch (error) {
        observation.outcome = signal.aborted ? 'interrupted' : 'failed';
        observation.diagnostic = toWorkflowErrorDiagnostic(error, { includeContent: false });
        throw error;
      } finally {
        observation.durationMs = durationSince(observation.startedAt);
      }
    },
    snapshot: () =>
      observations.map(observation => ({
        ...(observation.diagnostic ? { diagnostic: observation.diagnostic } : {}),
        durationMs: observation.durationMs ?? durationSince(observation.startedAt),
        name: observation.name,
        outcome:
          observation.outcome === 'running' && signal.aborted ? 'interrupted' : observation.outcome,
      })),
  };
};
