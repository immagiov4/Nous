import express from 'express';
import cors from 'cors';

import ttsRouter from './routes/tts.js';
import voicesRouter from './routes/voices.js';
import statusRouter from './routes/status.js';
import pdfRouter from './routes/pdf.js';
import chatRouter from './routes/chat.js';

export const createApp = () => {
  const app = express();

  app.use(cors({
    origin: true,
    credentials: true,
  }));
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

  app.get('/', (_req, res) => {
    res.redirect('http://localhost:5173');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Backend] Unhandled error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  });

  return app;
};

export default createApp;
