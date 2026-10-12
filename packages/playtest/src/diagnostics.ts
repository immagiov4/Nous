import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';

export type DiagnosticRecord = { diagnostics?: Record<string, string> };
const scope = new AsyncLocalStorage<DiagnosticRecord>();

/** Nested story scopes isolate concurrent jobs; lower layers retain causes at their owner. */
export function withDiagnostics<T>(record: DiagnosticRecord, work: () => T): T {
  return scope.run(record, work);
}

/** Stable outcome messages stay separate from internal causes, including nested Error causes. */
export function recordDiagnostic(
  stage: string,
  error: unknown,
  options: {
    record?: DiagnosticRecord;
    label?: string;
  } = {}
): void {
  const cause =
    error instanceof Error ? `${error.name}: ${error.message}\n${inspect(error)}` : inspect(error);
  console.error(options.label ?? `[playtest] ${stage} failed:`, cause);
  const record = options.record ?? scope.getStore();
  if (!record) return;
  record.diagnostics ??= {};
  const previous = record.diagnostics[stage];
  record.diagnostics[stage] = previous ? `${previous}\n\n${cause}` : cause;
}
