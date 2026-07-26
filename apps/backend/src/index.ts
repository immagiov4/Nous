// Backend process entrypoint.
import './config/env.js';

import cors from 'cors';
import express from 'express';
import { resolveCurrentUser, resolveCurrentUserForPasswordSetup } from './auth/currentUser.js';
import { getBackendServerConfig, loadServerConfig } from './config/serverConfig.js';
import { admitProjectImportRequest } from './projects/projectImportAdmission.js';
import { projectImportConfig } from './projects/projectImportConfig.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import chatRouter from './routes/chat.js';
import codexRouter from './routes/codex.js';
import feedbackRouter from './routes/feedback.js';
import generationJobsRouter from './routes/generationJobs.js';
import imagesRouter from './routes/images.js';
import openRouterProxyRouter from './routes/openRouterProxy.js';
import pdfRouter from './routes/pdf.js';
import projectsRouter from './routes/projects.js';
import statusRouter from './routes/status.js';
import sttRouter from './routes/stt.js';
import ttsRouter from './routes/tts.js';
import voicesRouter from './routes/voices.js';
import waitlistRouter from './routes/waitlist.js';
import youtubeRouter from './routes/youtube.js';
import { timestampIso } from './utils/time.js';

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

const parseAllowedOrigins = (): Set<string> => {
  const configuredOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  return new Set(
    configuredOrigins && configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_FRONTEND_ORIGINS
  );
};

export const createApp = () => {
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
    })
  );
  app.use('/api/openrouter', express.json({ limit: OPENROUTER_JSON_BODY_LIMIT }));
  app.use('/api/pdf', express.json({ limit: PDF_JSON_BODY_LIMIT }));
  app.use('/api/projects', resolveCurrentUser);
  app.put(
    '/api/projects/import/chunks/:uploadId/:chunkIndex',
    admitProjectImportRequest,
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

  app.use((req, res, next) => {
    res.on('finish', () => {
      const requestPath = getRequestLogPath(req);
      if (shouldLogRequest(req.method, requestPath, res.statusCode)) {
        console.log(`[Backend] ${req.method} ${requestPath} -> ${res.statusCode}`);
      }
    });
    next();
  });

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
  app.use('/api/generation-jobs', resolveCurrentUser, generationJobsRouter);
  app.use('/api/openrouter', resolveCurrentUser, openRouterProxyRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/admin', resolveCurrentUser, adminRouter);

  app.get('/', (_req, res) => {
    res.redirect('http://localhost:5173');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: timestampIso() });
  });

  app.use(
    (
      err: Error & { status?: number; type?: string },
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

      console.error('[Backend] Unhandled error:', err);
      res.status(500).json({
        success: false,
        error: 'Errore interno del server.',
      });
    }
  );

  return app;
};

export default createApp;
