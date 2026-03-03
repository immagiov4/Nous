import express from 'express';
import cors from 'cors';
import { processManager } from './services/processManager.js';
import { loadServerConfig } from './config/serverConfig.js';

// Import routes
import ttsRouter from './routes/tts.js';
import voicesRouter from './routes/voices.js';
import statusRouter from './routes/status.js';

const app = express();
const config = loadServerConfig();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`[Backend] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/tts', ttsRouter);
app.use('/api/voices', voicesRouter);
app.use('/api/status', statusRouter);

// Root redirect to frontend
app.get('/', (req, res) => {
  res.redirect('http://localhost:5173');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Backend] Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});

// Start server
const PORT = process.env.BACKEND_PORT || 3001;

app.listen(PORT, () => {
  console.log(`[Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Backend] TTS API available at http://localhost:${PORT}/api/tts`);
  console.log('[Backend] Expecting TTS server to be running externally on port 8880');
});

// Graceful shutdown
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
