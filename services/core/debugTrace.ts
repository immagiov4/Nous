declare global {
  interface Window {
    __nousDebugTrace?: Array<{
      event: string;
      payload?: Record<string, unknown>;
      timestamp: string;
    }>;
  }
}

const MAX_TRACE_ENTRIES = 200;

export const pushNousDebugTrace = (event: string, payload?: Record<string, unknown>): void => {
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
    const trace = window.__nousDebugTrace || [];
    trace.push(entry);
    if (trace.length > MAX_TRACE_ENTRIES) {
      trace.splice(0, trace.length - MAX_TRACE_ENTRIES);
    }
    window.__nousDebugTrace = trace;
  }

  console.info(`[Nous][Trace] ${event}`, payload || {});
};
