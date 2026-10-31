// Backend process entrypoint.
import './config/env.js';

import cors from 'cors';
import express from 'express';
import { resolveCurrentUser, resolveCurrentUserForPasswordSetup } from './auth/currentUser.js';
import { getBackendServerConfig, loadServerConfig } from './config/serverConfig.js';
import { type LibraryExportApi, unavailableLibraryExportApi } from './projects/libraryExport.js';
import {
  type ProjectAssetReader,
  unavailableProjectAssetReader,
} from './projects/projectAssetReader.js';
import { admitProjectImportRequest } from './projects/projectImportAdmission.js';
import { projectImportConfig } from './projects/projectImportConfig.js';
import { createAccountRouter } from './routes/account.js';
import adminRouter from './routes/admin.js';
import { createArtifactDraftRouter } from './routes/artifactDrafts.js';
import authRouter from './routes/auth.js';
import chatRouter from './routes/chat.js';
import codexRouter from './routes/codex.js';
import { createCourseInterviewRouter } from './routes/courseInterviews.js';
import { createCourseWorkflowRouter } from './routes/courseWorkflows.js';
import feedbackRouter from './routes/feedback.js';
import imagesRouter from './routes/images.js';
import { createLessonPlaybackRouter } from './routes/lessonPlayback.js';
import { createLessonVisualRetryRouter } from './routes/lessonVisualRetries.js';
import { createLessonWorkflowRouter } from './routes/lessonWorkflows.js';
import {
  createLibraryExportDownloadRouter,
  createLibraryExportRouter,
} from './routes/libraryExports.js';
import openRouterProxyRouter from './routes/openRouterProxy.js';
import pdfRouter from './routes/pdf.js';
import { createProjectAssetRouter } from './routes/projectAssets.js';
import projectsRouter from './routes/projects.js';
import statusRouter from './routes/status.js';
import sttRouter from './routes/stt.js';
import ttsRouter from './routes/tts.js';
import voicesRouter from './routes/voices.js';
import waitlistRouter from './routes/waitlist.js';
import {
  createWorkflowOutboxAdminRouter,
  type WorkflowOutboxAdmin,
} from './routes/workflowOutboxAdmin.js';
import { createWorkflowRouter } from './routes/workflows.js';
import youtubeRouter from './routes/youtube.js';
import { sanitizeDiagnosticText } from './utils/sanitizeDiagnosticText.js';
import { timestampIso } from './utils/time.js';
import {
  type ArtifactDraftApi,
  unavailableArtifactDraftApi,
} from './workflows/artifactDraftApi.js';
import {
  type CourseGenerationApi,
  unavailableCourseGenerationApi,
} from './workflows/courseGenerationApi.js';
import {
  type CourseInterviewApi,
  unavailableCourseInterviewApi,
} from './workflows/courseInterviewApi.js';
import {
  type LessonGenerationApi,
  unavailableLessonGenerationApi,
} from './workflows/lessonGenerationApi.js';
import {
  type LessonPlaybackApi,
  unavailableLessonPlaybackApi,
} from './workflows/lessonPlaybackApi.js';
import {
  type LessonVisualRetryStarter,
  unavailableLessonVisualRetryStarter,
} from './workflows/lessonVisualRetryStart.js';
import {
  type PdfMappingRepairApi,
  unavailablePdfMappingRepairApi,
} from './workflows/pdfMappingRepairApi.js';
import {
  createCorrelationId,
  getCorrelationId,
  getRequestTimings,
  recordRequestTiming,
  runWithCorrelationId,
} from './workflows/requestObservability.js';
import {
  unavailableWorkflowRuntimeApi,
  type WorkflowRuntimeApi,
} from './workflows/runtime/workflowRuntimeApi.js';
import type { StepFailure } from './workflows/types.js';
import { toWorkflowErrorDiagnostic } from './workflows/workflowErrorDiagnostics.js';
import { consoleWorkflowLogger, emitWorkflowLog } from './workflows/workflowObservability.js';

const DEFAULT_FRONTEND_PORT = '5173';
const DEFAULT_FRONTEND_ORIGINS = [
  `http://localhost:${DEFAULT_FRONTEND_PORT}`,
  `http://127.0.0.1:${DEFAULT_FRONTEND_PORT}`,
];
const DEFAULT_JSON_BODY_LIMIT = '50mb';
const OPENROUTER_JSON_BODY_LIMIT = '80mb';
const PDF_JSON_BODY_LIMIT = '160mb';
const PROJECTS_JSON_BODY_LIMIT = '300mb';
const STT_JSON_BODY_LIMIT = '20mb';
const FEEDBACK_JSON_BODY_LIMIT = '2mb';
const QUIET_SUCCESS_GET_PATHS = new Set(['/api/status', '/api/voices']);
const REQUEST_FAILURE_LOCAL = 'workflowLifecycleFailure';
const SAFE_REQUEST_LOG_PATHS = new Set([...QUIET_SUCCESS_GET_PATHS, '/health']);
const UNMATCHED_REQUEST_ROUTE = 'unmatched';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const isPrivateIpv4Address = (hostname: string): boolean => {
  const octets = hostname.split('.').map(value => Number.parseInt(value, 10));
  if (
    octets.length !== 4 ||
    octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

export const isPrivateNetworkFrontendOrigin = (origin: string): boolean => {
  try {
    const parsedOrigin = new URL(origin);
    return (
      parsedOrigin.protocol === 'http:' &&
      parsedOrigin.port === DEFAULT_FRONTEND_PORT &&
      isPrivateIpv4Address(parsedOrigin.hostname)
    );
  } catch {
    return false;
  }
};

const shouldLogRequest = (method: string, path: string, statusCode: number): boolean =>
  !(method === 'GET' && statusCode < 400 && QUIET_SUCCESS_GET_PATHS.has(path));

const getRequestPath = (req: express.Request): string => req.originalUrl.split('?')[0] || req.path;

const getRequestLogPath = (req: express.Request): string => {
  const requestPath = getRequestPath(req);
  if (SAFE_REQUEST_LOG_PATHS.has(requestPath)) return requestPath;
  const routePath: unknown = req.route?.path;
  if (typeof routePath !== 'string') return UNMATCHED_REQUEST_ROUTE;
  if (!req.baseUrl) return routePath;
  return routePath === '/' ? req.baseUrl : `${req.baseUrl}${routePath}`;
};

const readSafeStackFrames = (error: Error): string | undefined => {
  const stackFrames = error.stack?.split('\n').slice(1).join('\n').trim();
  return stackFrames ? sanitizeDiagnosticText(stackFrames, stackFrames.length) : undefined;
};

const toBackendErrorDiagnostic = (
  error: Error & { code?: string; status?: number; type?: string }
) =>
  toWorkflowErrorDiagnostic(
    error,
    error.type === 'entity.parse.failed' ? {} : { trustedMessage: error.message }
  );

const requireProjectImportChunkContentType: express.RequestHandler = (req, res, next) => {
  if (req.is('application/octet-stream') || req.is('text/plain')) {
    next();
    return;
  }
  res.status(415).json({
    error: 'Tipo di contenuto del blocco di importazione non supportato.',
    success: false,
  });
};

const parseAllowedOrigins = (): Set<string> => {
  const configuredOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  return new Set(
    configuredOrigins && configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_FRONTEND_ORIGINS
  );
};

export interface CreateAppOptions {
  artifactDraftApi?: ArtifactDraftApi;
  courseGenerationApi?: CourseGenerationApi;
  courseInterviewApi?: CourseInterviewApi;
  lessonGenerationApi?: LessonGenerationApi;
  lessonPlaybackApi?: LessonPlaybackApi;
  lessonVisualRetryStarter?: LessonVisualRetryStarter;
  libraryExportApi?: LibraryExportApi;
  pdfMappingRepairApi?: PdfMappingRepairApi;
  projectAssetReader?: ProjectAssetReader;
  workflowOutboxAdmin?: WorkflowOutboxAdmin;
  workflowRuntimeApi?: WorkflowRuntimeApi;
}

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();
  const allowedOrigins = parseAllowedOrigins();
  const backendConfig = getBackendServerConfig(loadServerConfig());
  const backendOrigins = new Set([
    `http://localhost:${backendConfig.backendPort}`,
    `http://127.0.0.1:${backendConfig.backendPort}`,
  ]);

  app.use((req, res, next) => {
    const requestedCorrelationId = req.header('x-request-id')?.trim();
    const correlationId =
      requestedCorrelationId && UUID_PATTERN.test(requestedCorrelationId)
        ? requestedCorrelationId.toLowerCase()
        : createCorrelationId();
    const started = performance.now();
    let timings: Record<string, number> | undefined;
    let responseBytes = 0;
    const countResponseChunk = (chunk: unknown, encoding: unknown): void => {
      // Count body bytes handed to Node, excluding bodyless HTTP responses.
      if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) return;
      if (typeof chunk === 'string') {
        responseBytes += Buffer.byteLength(
          chunk,
          typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined
        );
      } else if (chunk instanceof Uint8Array) {
        responseBytes += chunk.byteLength;
      }
    };
    const write = res.write;
    res.write = function (...args: unknown[]) {
      countResponseChunk(args[0], args[1]);
      return Reflect.apply(write, this, args);
    };
    const end = res.end;
    res.end = function (...args: unknown[]) {
      countResponseChunk(args[0], args[1]);
      return Reflect.apply(end, this, args);
    };
    res.setHeader('x-request-id', correlationId);
    const json = res.json;
    const send = res.send;
    let serializationStarted: number | undefined;
    res.json = function (body) {
      serializationStarted = performance.now();
      try {
        return json.call(this, body);
      } finally {
        serializationStarted = undefined;
      }
    };
    res.send = function (body) {
      if (serializationStarted !== undefined && typeof body === 'string') {
        recordRequestTiming('serialization', performance.now() - serializationStarted);
        const phases = Object.entries(timings ?? {}).map(
          ([phase, duration]) => `${phase};dur=${duration.toFixed(2)}`
        );
        if (phases.length) this.append('Server-Timing', phases.join(', '));
      }
      return send.call(this, body);
    };
    res.on('finish', () => {
      if (!shouldLogRequest(req.method, getRequestPath(req), res.statusCode)) {
        return;
      }
      const failure = res.locals[REQUEST_FAILURE_LOCAL] as StepFailure | undefined;
      emitWorkflowLog(consoleWorkflowLogger, {
        action: res.statusCode >= 400 ? 'failed' : 'completed',
        correlationId,
        entity: 'lifecycle',
        ...(failure ? { failure } : {}),
        method: req.method,
        operation: 'http_request',
        durationMs: performance.now() - started,
        timings,
        responseBytes,
        path: getRequestLogPath(req),
        statusCode: res.statusCode,
      });
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        emitWorkflowLog(consoleWorkflowLogger, {
          action: 'disconnected',
          correlationId,
          entity: 'lifecycle',
          method: req.method,
          operation: 'http_request',
          durationMs: performance.now() - started,
          timings,
          responseBytes,
          path: getRequestLogPath(req),
        });
      }
    });
    runWithCorrelationId(correlationId, () => {
      timings = getRequestTimings();
      next();
    });
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.has(origin) ||
          backendOrigins.has(origin) ||
          isPrivateNetworkFrontendOrigin(origin)
        ) {
          callback(null, true);
          return;
        }

        callback(new Error('Origine non consentita dalla configurazione CORS.'));
      },
      credentials: true,
      exposedHeaders: ['x-request-id', 'Server-Timing'],
    })
  );
  app.use('/api/openrouter', express.json({ limit: OPENROUTER_JSON_BODY_LIMIT }));
  app.use('/api/pdf', express.json({ limit: PDF_JSON_BODY_LIMIT }));
  app.use(
    '/api/projects',
    createLibraryExportDownloadRouter(options.libraryExportApi ?? unavailableLibraryExportApi)
  );
  app.use('/api/projects', resolveCurrentUser);
  app.put(
    '/api/projects/import/chunks/:uploadId/:chunkIndex',
    requireProjectImportChunkContentType,
    admitProjectImportRequest,
    express.raw({ limit: projectImportConfig.maxChunkBytes, type: 'application/octet-stream' }),
    express.text({ limit: projectImportConfig.maxChunkBytes, type: 'text/plain' })
  );
  app.post('/api/projects/import/chunks/:uploadId/complete', admitProjectImportRequest);
  app.post(
    '/api/projects/import',
    admitProjectImportRequest,
    express.json({ limit: projectImportConfig.directMaxBytes + 1_024 })
  );
  app.use('/api/projects', express.json({ limit: PROJECTS_JSON_BODY_LIMIT }));
  app.use('/api/stt', express.json({ limit: STT_JSON_BODY_LIMIT }));
  app.use('/api/feedback', express.json({ limit: FEEDBACK_JSON_BODY_LIMIT }));
  app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));

  app.use('/api/tts', resolveCurrentUser, ttsRouter);
  app.use('/api/auth', resolveCurrentUserForPasswordSetup, authRouter);
  app.use('/api/account', resolveCurrentUser, createAccountRouter());
  app.use('/api/stt', resolveCurrentUser, sttRouter);
  app.use('/api/images', resolveCurrentUser, imagesRouter);
  app.use('/api/voices', voicesRouter);
  app.use('/api/status', statusRouter);
  app.use('/api/waitlist', waitlistRouter);
  app.use('/api/pdf', resolveCurrentUser, pdfRouter);
  app.use('/api/youtube', resolveCurrentUser, youtubeRouter);
  app.use('/api/chat', resolveCurrentUser, chatRouter);
  app.use('/api/codex', resolveCurrentUser, codexRouter);
  app.use('/api/feedback', resolveCurrentUser, feedbackRouter);
  app.use(
    '/api/artifact-drafts',
    resolveCurrentUser,
    createArtifactDraftRouter(options.artifactDraftApi ?? unavailableArtifactDraftApi)
  );
  app.use(
    '/api/course-interviews',
    resolveCurrentUser,
    createCourseInterviewRouter(options.courseInterviewApi ?? unavailableCourseInterviewApi)
  );
  app.use(
    '/api/course-workflows',
    resolveCurrentUser,
    createCourseWorkflowRouter(
      options.courseGenerationApi ?? unavailableCourseGenerationApi,
      options.pdfMappingRepairApi ?? unavailablePdfMappingRepairApi
    )
  );
  app.use(
    '/api/lesson-workflows',
    resolveCurrentUser,
    createLessonWorkflowRouter(options.lessonGenerationApi ?? unavailableLessonGenerationApi)
  );
  app.use(
    '/api/workflows',
    resolveCurrentUser,
    createWorkflowRouter(options.workflowRuntimeApi ?? unavailableWorkflowRuntimeApi)
  );
  app.use('/api/openrouter', resolveCurrentUser, openRouterProxyRouter);
  app.use(
    '/api/projects',
    createProjectAssetRouter(options.projectAssetReader ?? unavailableProjectAssetReader)
  );
  app.use(
    '/api/projects',
    createLibraryExportRouter(options.libraryExportApi ?? unavailableLibraryExportApi)
  );
  app.use(
    '/api/projects',
    createLessonVisualRetryRouter(
      options.lessonVisualRetryStarter ?? unavailableLessonVisualRetryStarter
    )
  );
  app.use(
    '/api/projects',
    createLessonPlaybackRouter(options.lessonPlaybackApi ?? unavailableLessonPlaybackApi)
  );
  app.use('/api/projects', projectsRouter);
  if (options.workflowOutboxAdmin) {
    app.use(
      '/api/admin/workflow-outbox',
      resolveCurrentUser,
      createWorkflowOutboxAdminRouter(options.workflowOutboxAdmin)
    );
  }
  app.use('/api/admin', resolveCurrentUser, adminRouter);

  app.get('/', (_req, res) => {
    res.redirect('http://localhost:5173');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: timestampIso() });
  });

  app.use(
    (
      err: Error & { code?: string; status?: number; type?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err.type === 'entity.too.large' || err.status === 413) {
        const diagnostic = toBackendErrorDiagnostic(err);
        res.locals[REQUEST_FAILURE_LOCAL] = {
          code: 'request_payload_too_large',
          details: { diagnostic },
          kind: 'permanent',
          message: 'Request payload exceeded its configured limit.',
        } satisfies StepFailure;
        console.warn('[Backend] Request payload too large:', {
          correlationId: getCorrelationId(),
          status: err.status,
          type: err.type,
        });
        res.status(413).json({
          success: false,
          error: 'Il file è troppo grande per questa richiesta.',
        });
        return;
      }

      const diagnostic = toBackendErrorDiagnostic(err);
      const stack = readSafeStackFrames(err);
      res.locals[REQUEST_FAILURE_LOCAL] = {
        code: err.code ?? 'backend_unhandled_error',
        details: { diagnostic },
        kind: 'operational',
        message: 'Unhandled backend exception.',
      } satisfies StepFailure;

      console.error('[Backend] Unhandled error:', {
        correlationId: getCorrelationId(),
        diagnostic,
        ...(stack ? { stack } : {}),
      });
      res.status(500).json({
        success: false,
        error: 'Errore interno del server.',
      });
    }
  );

  return app;
};

export default createApp;
