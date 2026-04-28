import cors from 'cors';
import express from 'express';
import { getBackendServerConfig, loadServerConfig } from './config/serverConfig.js';
import chatRouter from './routes/chat.js';
import openRouterProxyRouter from './routes/openRouterProxy.js';
import pdfRouter from './routes/pdf.js';
import projectsRouter from './routes/projects.js';
import statusRouter from './routes/status.js';
import ttsRouter from './routes/tts.js';
import voicesRouter from './routes/voices.js';

const DEFAULT_FRONTEND_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

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
        if (!origin || allowedOrigins.has(origin) || backendOrigins.has(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error('Origine non consentita dalla configurazione CORS.'));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '50mb' }));

  app.use((req, _res, next) => {
    console.log(`[Backend] ${req.method} ${req.path}`);
    next();
  });

  app.use('/api/tts', ttsRouter);
  app.use('/api/voices', voicesRouter);
  app.use('/api/status', statusRouter);
  app.use('/api/pdf', pdfRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/openrouter', openRouterProxyRouter);
  app.use('/api/projects', projectsRouter);

  app.get('/', (_req, res) => {
    res.redirect('http://localhost:5173');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
