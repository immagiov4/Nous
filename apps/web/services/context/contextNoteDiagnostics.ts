import {
  type ContextNoteEvent,
  type ContextNoteEventPayload,
  ContextNoteEventSchema,
} from '@shared/contextNote';
import { v4 as uuidv4 } from 'uuid';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

type TimedNoteEvent = {
  [Phase in ContextNoteEventPayload['phase']]: Omit<
    Extract<ContextNoteEventPayload, { phase: Phase }>,
    'durationMs'
  >;
}[ContextNoteEventPayload['phase']];

/** Session-local tool identities stay in memory; diagnostics use opaque application UUIDs. */
export const createContextNoteDiagnostics = () => {
  const operations = new Map<
    string,
    { operationId: string; reported: Set<ContextNoteEvent['phase']> }
  >();
  const report = async (toolCallId: string, event: ContextNoteEventPayload): Promise<void> => {
    let operation = operations.get(toolCallId);
    if (!operation) {
      operation = { operationId: uuidv4(), reported: new Set() };
      operations.set(toolCallId, operation);
    }
    if (operation.reported.has(event.phase)) return;
    const parsed = ContextNoteEventSchema.safeParse({
      ...event,
      operationId: operation.operationId,
    });
    if (!parsed.success) {
      console.warn('[Nous][ContextNote] invalid_event');
      return;
    }
    operation.reported.add(event.phase);
    // The feedback console buffer preserves strings, but turns object arguments into [Object].
    console.info(`[Nous][ContextNote] ${JSON.stringify(parsed.data)}`);
    try {
      const response = await fetchWithSupabaseAuth(
        `${getBackendUrl()}/api/chat/context/note-events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.data),
        }
      );
      if (response.ok) return;
    } catch {
      // Reporting must never change the outcome of a note operation or leak a transport cause.
    }
    console.warn(`[Nous][ContextNote] delivery_failed ${operation.operationId}`);
  };
  return {
    report,
    measure: (toolCallId: string) => {
      const started = performance.now();
      return (event: TimedNoteEvent) =>
        report(toolCallId, { ...event, durationMs: performance.now() - started });
    },
  };
};
