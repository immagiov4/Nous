import type { WorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';
import { toWorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';

export type WorkflowSubstageName =
  | 'load-project'
  | 'extract-pdf-images'
  | 'stage-assets'
  | 'caption-images'
  | 'caption-image'
  | 'read-provider-effect'
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
    // One entry per substage name keeps persisted details bounded however many images repeat.
    snapshot: () => {
      const entries = new Map<WorkflowSubstageName, SubstageSnapshotEntry>();
      for (const observation of observations) {
        const durationMs = observation.durationMs ?? durationSince(observation.startedAt);
        const outcome =
          observation.outcome === 'running' && signal.aborted ? 'interrupted' : observation.outcome;
        const entry = entries.get(observation.name);
        if (!entry) {
          entries.set(observation.name, {
            ...(observation.diagnostic ? { diagnostic: observation.diagnostic } : {}),
            durationMs,
            name: observation.name,
            outcome,
          });
          continue;
        }
        entry.count = (entry.count ?? 1) + 1;
        entry.totalDurationMs = (entry.totalDurationMs ?? entry.durationMs) + durationMs;
        entry.durationMs = Math.max(entry.durationMs, durationMs);
        entry.outcomes = entry.outcomes ?? { [entry.outcome]: 1 };
        entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + 1;
        if (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[entry.outcome]) entry.outcome = outcome;
        if (!entry.diagnostic && observation.diagnostic) entry.diagnostic = observation.diagnostic;
      }
      return [...entries.values()];
    },
  };
};

type SubstageOutcome = SubstageObservation['outcome'];

const OUTCOME_SEVERITY: Record<SubstageOutcome, number> = {
  succeeded: 0,
  running: 1,
  failed: 2,
  interrupted: 3,
};

/** Repeated names add count, summed duration and per-outcome counts; durationMs is the longest. */
type SubstageSnapshotEntry = {
  count?: number;
  diagnostic?: WorkflowErrorDiagnostic;
  durationMs: number;
  name: WorkflowSubstageName;
  outcome: SubstageOutcome;
  outcomes?: Partial<Record<SubstageOutcome, number>>;
  totalDurationMs?: number;
};
