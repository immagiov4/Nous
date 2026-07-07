// Streams OpenRouter responses through the backend proxy.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { type Request, type Response, Router } from 'express';

import { requireOpenRouterApiKey } from '../config/chatConfig.js';
import { getResolvedGlobalModelConfig } from '../config/modelConfig.js';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_RESPONSE_HEADERS = ['content-type', 'cache-control'] as const;

const getRequestOrigin = (req: Request): string => {
  const origin = req.get('origin')?.trim();
  if (origin) {
    return origin;
  }

  return `${req.protocol}://${req.get('host') || 'localhost'}`;
};

const forwardOpenRouterHeaders = (req: Request): HeadersInit => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${requireOpenRouterApiKey()}`,
  'HTTP-Referer': getRequestOrigin(req),
  'X-Title': 'Nous Reader',
});

const resolveProxyModel = async (req: Request): Promise<string> => {
  const modelConfig = await getResolvedGlobalModelConfig();
  const slot = req.get('x-nous-model-slot')?.trim();

  if (slot === 'assessment') {
    return modelConfig.assessmentModel;
  }

  if (slot === 'context') {
    return modelConfig.contextModel;
  }

  return modelConfig.lessonModel;
};

const pipeOpenRouterResponse = (upstreamResponse: globalThis.Response, res: Response): void => {
  res.status(upstreamResponse.status);

  for (const headerName of OPENROUTER_RESPONSE_HEADERS) {
    const headerValue = upstreamResponse.headers.get(headerName);
    if (headerValue) {
      res.setHeader(headerName, headerValue);
    }
  }

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream<Uint8Array>).pipe(res);
};

const router = Router();

router.post('/chat/completions', async (req: Request, res: Response) => {
  try {
    const upstreamResponse = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: forwardOpenRouterHeaders(req),
      body: JSON.stringify({
        ...req.body,
        model: await resolveProxyModel(req),
      }),
    });

    pipeOpenRouterResponse(upstreamResponse, res);
  } catch (error) {
    console.error('[OpenRouter Proxy] Error:', error);
    res.status(502).json({
      success: false,
      error: 'Il servizio AI non ha completato la richiesta. Riprova tra poco.',
    });
  }
});

export default router;
