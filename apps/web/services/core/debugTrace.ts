declare global {
  interface Window {
    __nousDebugTrace?: Array<{
      event: string;
      payload?: Record<string, unknown>;
      timestamp: string;
    }>;
  }
}

import { timestampIso } from '../../utils/time.ts';

const MAX_TRACE_ENTRIES = 200;
const MAX_FORENSIC_TRACE_ENTRIES = 40;
const MAX_FORENSIC_TRACE_STORAGE_CHARS = 4_000_000;
const FORENSIC_TRACE_STORAGE_KEY = 'nous:lesson-forensics';
const FORENSIC_TRACE_ELEMENT_ID = 'nous-lesson-forensics';
const isDebugTraceEnabled = import.meta.env.DEV;

const persistForensicTrace = (entry: {
  event: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}): void => {
  if (!entry.event.includes('forensics:')) {
    return;
  }

  try {
    const storedTrace = globalThis.window.sessionStorage.getItem(FORENSIC_TRACE_STORAGE_KEY);
    const parsedTrace = storedTrace ? (JSON.parse(storedTrace) as unknown) : [];
    const trace = Array.isArray(parsedTrace) ? parsedTrace : [];
    trace.push(entry);
    trace.splice(0, Math.max(0, trace.length - MAX_FORENSIC_TRACE_ENTRIES));

    let serializedTrace = JSON.stringify(trace);
    while (serializedTrace.length > MAX_FORENSIC_TRACE_STORAGE_CHARS && trace.length > 1) {
      trace.shift();
      serializedTrace = JSON.stringify(trace);
    }
    globalThis.window.sessionStorage.setItem(FORENSIC_TRACE_STORAGE_KEY, serializedTrace);
    const traceElement =
      globalThis.document.getElementById(FORENSIC_TRACE_ELEMENT_ID) ||
      globalThis.document.head.appendChild(globalThis.document.createElement('script'));
    traceElement.id = FORENSIC_TRACE_ELEMENT_ID;
    traceElement.setAttribute('type', 'application/json');
    traceElement.setAttribute('hidden', '');
    traceElement.textContent = serializedTrace;
  } catch (error) {
    console.warn('[Nous][Trace] Could not persist lesson forensics.', error);
  }
};

export const pushNousDebugTrace = (event: string, payload?: Record<string, unknown>): void => {
  if (!isDebugTraceEnabled) {
    return;
  }

  const entry = {
    event,
    payload,
    timestamp: timestampIso(),
  };

  if (typeof globalThis.window !== 'undefined') {
    const trace = globalThis.window.__nousDebugTrace || [];
    trace.push(entry);
    if (trace.length > MAX_TRACE_ENTRIES) {
      trace.splice(0, trace.length - MAX_TRACE_ENTRIES);
    }
    globalThis.window.__nousDebugTrace = trace;
    persistForensicTrace(entry);
  }

  console.info(`[Nous][Trace] ${event}`, payload || {});
};
