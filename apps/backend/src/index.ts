// Backend process entrypoint.
import './config/env.js';

import cors from 'cors';
import express from 'express';
import { resolveCurrentUser, resolveCurrentUserForPasswordSetup } from './auth/currentUser.js';
import { getBackendServerConfig, loadServerConfig } from './config/serverConfig.js';
import {
  type ProjectAssetReader,
  unavailableProjectAssetReader,
} from './projects/projectAssetReader.js';
import { admitProjectImportRequest } from './projects/projectImportAdmission.js';
import { projectImportConfig } from './projects/projectImportConfig.js';
import adminRouter from './routes/admin.js';
import { createArtifactDraftRouter } from './routes/artifactDrafts.js';
import authRouter from './routes/auth.js';
import chatRouter from './routes/chat.js';
import codexRouter from './routes/codex.js';
import { createCourseInterviewRouter } from './routes/courseInterviews.js';
import { createCourseWorkflowRouter } from './routes/courseWorkflows.js';
import feedbackRouter from './routes/feedback.js';
import imagesRouter from './routes/images.js';
import { createLessonVisualRetryRouter } from './routes/lessonVisualRetries.js';
import { createLessonWorkflowRouter } from './routes/lessonWorkflows.js';
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
  runWithCorrelationId,
} from './workflows/requestObservability.js';
import {
  unavailableWorkflowRuntimeApi,
  type WorkflowRuntimeApi,
} from './workflows/runtime/workflowRuntimeApi.js';
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

const shouldLogRequest = (method: string, path: string, statusCode: number): boolean => {
  if (method === 'GET' && statusCode < 400 && QUIET_SUCCESS_GET_PATHS.has(path)) {
    return false;
  }

  return true;
};

const getRequestLogPath = (req: express.Request): string =>
  req.originalUrl.split('?')[0] || req.path;

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
  lessonVisualRetryStarter?: LessonVisualRetryStarter;
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
      exposedHeaders: ['x-request-id'],
    })
  );
  app.use((req, res, next) => {
    const requestedCorrelationId = req.header('x-request-id')?.trim();
    const correlationId =
      requestedCorrelationId && UUID_PATTERN.test(requestedCorrelationId)
        ? requestedCorrelationId
        : createCorrelationId();
    res.setHeader('x-request-id', correlationId);
    res.on('finish', () => {
      const requestPath = getRequestLogPath(req);
      if (shouldLogRequest(req.method, requestPath, res.statusCode)) {
        emitWorkflowLog(consoleWorkflowLogger, {
          action: res.statusCode >= 400 ? 'failed' : 'completed',
          correlationId,
          entity: 'lifecycle',
          method: req.method,
          operation: 'http_request',
          path: requestPath,
          statusCode: res.statusCode,
        });
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        emitWorkflowLog(consoleWorkflowLogger, {
          action: 'disconnected',
          correlationId,
          entity: 'lifecycle',
          method: req.method,
          operation: 'http_request',
          path: getRequestLogPath(req),
        });
      }
    });
    runWithCorrelationId(correlationId, next);
  });
  app.use('/api/openrouter', express.json({ limit: OPENROUTER_JSON_BODY_LIMIT }));
  app.use('/api/pdf', express.json({ limit: PDF_JSON_BODY_LIMIT }));
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
    createLessonVisualRetryRouter(
      options.lessonVisualRetryStarter ?? unavailableLessonVisualRetryStarter
    )
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
        console.warn('[Backend] Request payload too large:', {
          status: err.status,
          type: err.type,
        });
        res.status(413).json({
          success: false,
          error: 'Il file e troppo grande per questa richiesta.',
        });
        return;
      }

      const diagnostic = toBackendErrorDiagnostic(err);
      const stack = readSafeStackFrames(err);
      emitWorkflowLog(consoleWorkflowLogger, {
        action: 'failed',
        entity: 'lifecycle',
        failure: {
          code: err.code ?? 'backend_unhandled_error',
          details: { diagnostic },
          kind: 'operational',
          message: 'Unhandled backend exception.',
        },
        operation: 'http_request',
        path: getRequestLogPath(_req),
        statusCode: 500,
      });

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
