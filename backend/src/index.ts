import express from 'express';
import cors from 'cors';

import { buildTTSServerUrl, loadServerConfig } from './config/serverConfig.js';
import { processManager } from './services/processManager.js';

import ttsRouter from './routes/tts.js';
import voicesRouter from './routes/voices.js';
import statusRouter from './routes/status.js';
import pdfRouter from './routes/pdf.js';

const app = express();
const config = loadServerConfig();

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
    error: 'Internal server error' 
  });
});

const PORT = process.env.BACKEND_PORT || 3001;

app.listen(PORT, () => {
  console.log(`[Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Backend] TTS API available at http://localhost:${PORT}/api/tts`);
  console.log(`[Backend] Expecting TTS server at ${buildTTSServerUrl(config)}`);
});

process.on('SIGTERM', async () => {
  console.log('[Backend] SIGTERM received, shutting down...');
  await processManager.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Backend] SIGINT received, shutting down...');
  await processManager.stop();
  process.exit(0);
});

export default app;
