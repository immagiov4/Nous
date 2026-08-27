import {
  type FeedbackBreadcrumb,
  type FeedbackProductContext,
  type FeedbackProductSurface,
  type FeedbackWorkflowOperation,
  type FeedbackWorkflowStatus,
  MAX_FEEDBACK_BREADCRUMB_ENTRIES,
} from '@shared/feedbackDiagnosticsContract';

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
  productContext?: FeedbackProductContext;
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
const CORRELATION_ID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const EXACT_CORRELATION_ID_PATTERN = new RegExp(`^(?:${CORRELATION_ID_PATTERN.source})$`, 'iu');

const entries: FeedbackConsoleEntry[] = [];
const productBreadcrumbs: FeedbackBreadcrumb[] = [];
let productContext: Omit<FeedbackProductContext, 'breadcrumbs'> = {};
let workflowSectionId: string | undefined;
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

const appendProductBreadcrumb = (breadcrumb: FeedbackBreadcrumb): void => {
  productBreadcrumbs.push(breadcrumb);
  if (productBreadcrumbs.length > MAX_FEEDBACK_BREADCRUMB_ENTRIES) {
    productBreadcrumbs.splice(0, productBreadcrumbs.length - MAX_FEEDBACK_BREADCRUMB_ENTRIES);
  }
};

const recordProductBreadcrumb = (
  operation: FeedbackBreadcrumb['operation'],
  surface: FeedbackProductSurface,
  context: Pick<FeedbackProductContext, 'project' | 'section'>
): void => {
  appendProductBreadcrumb({
    operation,
    ...(context.project ? { projectId: context.project.id } : {}),
    ...(context.section ? { sectionId: context.section.id } : {}),
    surface,
    timestamp: new Date().toISOString(),
  });
};

const sanitizeProductReference = (
  reference: FeedbackProductContext['project'] | FeedbackProductContext['section'] | undefined
): FeedbackProductContext['project'] | FeedbackProductContext['section'] | undefined => {
  if (!reference) return undefined;

  const id = reference.id.trim();
  if (!id) return undefined;

  return {
    id,
    ...(reference.revision === undefined ? {} : { revision: reference.revision }),
  };
};

export const setFeedbackProductContext = (
  nextContext: Omit<FeedbackProductContext, 'breadcrumbs' | 'workflow'>
): void => {
  const project = sanitizeProductReference(nextContext.project);
  const section = sanitizeProductReference(nextContext.section);
  const surface = nextContext.surface;
  const previous = productContext;
  const preservesWorkflow =
    previous.workflow !== undefined &&
    previous.project?.id === project?.id &&
    (previous.section?.id === section?.id || workflowSectionId === section?.id);

  if (surface && surface !== previous.surface) {
    recordProductBreadcrumb('visited-surface', surface, { project, section });
  }
  if (project && project.id !== previous.project?.id && surface) {
    recordProductBreadcrumb('opened-project', surface, { project, section });
  }
  if (section && section.id !== previous.section?.id && surface) {
    recordProductBreadcrumb('opened-section', surface, { project, section });
  }

  productContext = {
    ...(project ? { project } : {}),
    ...(section ? { section } : {}),
    ...(surface ? { surface } : {}),
    ...(preservesWorkflow ? { workflow: previous.workflow } : {}),
  };
  if (!preservesWorkflow) workflowSectionId = undefined;
};

export const recordFeedbackWorkflowSnapshot = ({
  operation,
  projectId,
  runId,
  sectionId,
  status,
}: {
  operation: FeedbackWorkflowOperation;
  projectId: string;
  runId: string;
  sectionId?: string;
  status: FeedbackWorkflowStatus;
}): void => {
  if (productContext.project?.id !== projectId || !productContext.surface) return;

  const workflow = { operation, runId: runId.trim(), status };
  workflowSectionId = sectionId?.trim() || undefined;
  const previousWorkflow = productContext.workflow;
  if (
    previousWorkflow?.operation !== workflow.operation ||
    previousWorkflow.runId !== workflow.runId ||
    previousWorkflow.status !== workflow.status
  ) {
    recordProductBreadcrumb('updated-workflow', productContext.surface, productContext);
  }
  productContext = { ...productContext, workflow };
};

const getCorrelationIds = (consoleEntries: FeedbackConsoleEntry[]): string[] | undefined => {
  const ids = new Set<string>();
  for (let entryIndex = consoleEntries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = consoleEntries[entryIndex];
    if (!entry) continue;
    if (!CORRELATION_CONTEXT_PATTERN.test(entry.message)) continue;
    const matches = entry.message.match(CORRELATION_ID_PATTERN) || [];
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
      const match = matches[matchIndex];
      if (!match) continue;
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
    ...(productContext.surface
      ? {
          productContext: {
            ...productContext,
            breadcrumbs: productBreadcrumbs.map(breadcrumb => ({ ...breadcrumb })),
          },
        }
      : {}),
  };
};

export const clearFeedbackDiagnostics = (): void => {
  entries.length = 0;
  productBreadcrumbs.length = 0;
  productContext = {};
  workflowSectionId = undefined;
};

export const logBackendFailureCorrelationId = (value: unknown): void => {
  if (typeof value !== 'string') return;
  const correlationId = value.trim();
  if (!EXACT_CORRELATION_ID_PATTERN.test(correlationId)) return;
  console.warn(`[Nous][API] Codice assistenza: ${correlationId}`);
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
