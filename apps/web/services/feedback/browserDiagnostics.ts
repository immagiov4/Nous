export type FeedbackConsoleLevel = 'debug' | 'error' | 'info' | 'warn';

export interface FeedbackConsoleEntry {
  level: FeedbackConsoleLevel;
  message: string;
  timestamp: string;
}

export interface FeedbackDiagnosticsSnapshot {
  consoleEntries: FeedbackConsoleEntry[];
  correlationIds?: string[];
  pageUrl: string;
}

const MAX_CONSOLE_ENTRIES = 80;
const MAX_MESSAGE_LENGTH = 800;
const MAX_CORRELATION_IDS = 10;
const NOUS_LOG_PREFIX = '[Nous]';
const SENSITIVE_VALUE_PATTERN =
  /\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)["']?\s*[:=]\s*["']?[^\s,"'}]+["']?/gi;
const BEARER_PATTERN = /bearer\s+[a-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\b/g;
const PROVIDER_SECRET_PATTERN = /\b(?:github_pat_|gh[pousr]_|sk-)[a-z0-9_-]{16,}\b/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CORRELATION_CONTEXT_PATTERN = /(assistenza|correlation|request.?id)/i;
const CORRELATION_ID_PATTERN = /\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[a-z0-9][a-z0-9_-]{7,63})\b/gi;

const entries: FeedbackConsoleEntry[] = [];
let initialized = false;

const sanitizeUrl = (value: string): string => {
  try {
    const url = new URL(value, globalThis.location.origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[URL rimossa]';
  }
};

export const sanitizeFeedbackDiagnosticText = (value: string): string => {
  const withoutUrls = value.replaceAll(/https?:\/\/[^\s)\]}]+/gi, match => sanitizeUrl(match));
  return withoutUrls
    .replaceAll(SENSITIVE_VALUE_PATTERN, '$1=[RIMOSSO]')
    .replaceAll(BEARER_PATTERN, 'Bearer [RIMOSSO]')
    .replaceAll(JWT_PATTERN, '[TOKEN RIMOSSO]')
    .replaceAll(PROVIDER_SECRET_PATTERN, '[TOKEN RIMOSSO]')
    .replaceAll(EMAIL_PATTERN, '[EMAIL RIMOSSA]')
    .slice(0, MAX_MESSAGE_LENGTH);
};

const formatConsoleArgument = (value: unknown): string => {
  try {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      return String(value);
    }
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (Array.isArray(value)) return `[Array(${value.length})]`;
    return '[Object]';
  } catch {
    return '[Dati non leggibili]';
  }
};

const appendEntry = (level: FeedbackConsoleLevel, message: string) => {
  entries.push({
    level,
    message: sanitizeFeedbackDiagnosticText(message),
    timestamp: new Date().toISOString(),
  });
  if (entries.length > MAX_CONSOLE_ENTRIES) {
    entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
  }
};

const getCorrelationIds = (consoleEntries: FeedbackConsoleEntry[]): string[] | undefined => {
  const ids = new Set<string>();
  for (const entry of consoleEntries) {
    if (!CORRELATION_CONTEXT_PATTERN.test(entry.message)) continue;
    for (const match of entry.message.match(CORRELATION_ID_PATTERN) || []) {
      ids.add(match);
      if (ids.size === MAX_CORRELATION_IDS) return [...ids];
    }
  }
  return ids.size > 0 ? [...ids] : undefined;
};

export const getFeedbackDiagnosticsSnapshot = (): FeedbackDiagnosticsSnapshot => {
  const consoleEntries = entries.map(entry => ({ ...entry }));
  return {
    consoleEntries,
    correlationIds: getCorrelationIds(consoleEntries),
    pageUrl: sanitizeUrl(globalThis.location.href),
  };
};

export const clearFeedbackDiagnostics = (): void => {
  entries.length = 0;
};

export const initializeFeedbackDiagnostics = (): (() => void) => {
  if (initialized || typeof globalThis.window === 'undefined') return () => undefined;
  initialized = true;

  const originalMethods = new Map<FeedbackConsoleLevel, (...args: unknown[]) => void>();
  const levels: FeedbackConsoleLevel[] = ['debug', 'info', 'warn', 'error'];
  for (const level of levels) {
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originalMethods.set(level, original);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        if (
          !args.some(argument => typeof argument === 'string' && argument.includes(NOUS_LOG_PREFIX))
        ) {
          return;
        }
        appendEntry(level, args.map(formatConsoleArgument).join(' '));
      } catch {
        // Diagnostic collection must never affect the application call being observed.
      }
    };
  }

  const handleWindowError = (event: ErrorEvent) => {
    const source = event.filename ? ` (${sanitizeUrl(event.filename)}:${event.lineno})` : '';
    appendEntry('error', `Errore non gestito: ${event.message}${source}`);
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    appendEntry('error', `Promise non gestita: ${formatConsoleArgument(event.reason)}`);
  };
  globalThis.addEventListener('error', handleWindowError);
  globalThis.addEventListener('unhandledrejection', handleUnhandledRejection);

  return () => {
    for (const [level, original] of originalMethods) console[level] = original;
    globalThis.removeEventListener('error', handleWindowError);
    globalThis.removeEventListener('unhandledrejection', handleUnhandledRejection);
    initialized = false;
  };
};
