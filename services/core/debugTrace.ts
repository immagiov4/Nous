declare global {
  interface Window {
    __luminaDebugTrace?: Array<{
      event: string;
      payload?: Record<string, unknown>;
      timestamp: string;
    }>;
  }
}

const MAX_TRACE_ENTRIES = 200;

export const pushLuminaDebugTrace = (
  event: string,
  payload?: Record<string, unknown>
): void => {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  if (!meta.env?.DEV) {
    return;
  }

  const entry = {
    event,
    payload,
    timestamp: new Date().toISOString(),
  };

  if (typeof window !== 'undefined') {
    const trace = window.__luminaDebugTrace || [];
    trace.push(entry);
    if (trace.length > MAX_TRACE_ENTRIES) {
      trace.splice(0, trace.length - MAX_TRACE_ENTRIES);
    }
    window.__luminaDebugTrace = trace;
  }

  console.info(`[Lumina][Trace] ${event}`, payload || {});
};
