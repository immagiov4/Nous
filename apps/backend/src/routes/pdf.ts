// Exposes PDF upload and extraction routes.
import { PDF_TRANSCRIPTION_ERROR_CODE } from '@shared/pdfTranscription';
import { type Response, Router } from 'express';
import { getCurrentUser } from '../auth/currentUser.js';
import { getResolvedModelConfigForProvider } from '../config/modelConfig.js';
import { extractPdfImages } from '../services/pdfImageExtractor.js';
import { PdfPageTranscriptionError } from '../services/pdfPageTranscription.js';
import { extractPdfText } from '../services/pdfTextExtractor.js';
import { isPdfDataUrl, PDF_DATA_URL_REQUIRED_MESSAGE } from '../utils/pdfDataUrl.js';

const router = Router();
const DEFAULT_PDF_IMAGE_LIMIT = 20;
const MAX_PDF_IMAGE_LIMIT = 80;

const readPdfImageLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PDF_IMAGE_LIMIT;
  }

  return Math.max(1, Math.min(MAX_PDF_IMAGE_LIMIT, Math.trunc(value)));
};

const sendPdfTextFailure = (res: Response, error: unknown, streamed: boolean) => {
  const failure = {
    success: false,
    error:
      error instanceof PdfPageTranscriptionError
        ? error.message
        : 'Estrazione del testo dal PDF non riuscita.',
    ...(error instanceof PdfPageTranscriptionError
      ? { code: PDF_TRANSCRIPTION_ERROR_CODE, failedPages: error.failedPages }
      : {}),
  };
  if (streamed && res.headersSent)
    return res.end(`${JSON.stringify({ type: 'error', ...failure })}\n`);
  return res.status(error instanceof PdfPageTranscriptionError ? 422 : 500).json(failure);
};

router.post('/extract-text', async (req, res) => {
  const streamed = req.get('Accept') === 'application/x-ndjson';
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';

    if (!isPdfDataUrl(fileData)) {
      return res.status(400).json({
        success: false,
        error: PDF_DATA_URL_REQUIRED_MESSAGE,
      });
    }

    const currentUser = getCurrentUser(req);
    const config = await getResolvedModelConfigForProvider(
      currentUser.aiProvider,
      currentUser.aiProviderOverrides
    );
    if (streamed) {
      res.type('application/x-ndjson');
      res.set('Cache-Control', 'no-store');
      res.flushHeaders();
    }
    const result = await extractPdfText(fileData, {
      transcription: {
        config,
        signal: controller.signal,
        onProgress: streamed
          ? progress => {
              res.write(`${JSON.stringify({ type: 'progress', progress })}\n`);
            }
          : undefined,
      },
    });
    const payload = {
      success: true,
      transcription: result.transcription,
      text: result.text,
      textLength: result.text.length,
      parser: result.parser,
      sourceHash: result.sourceHash,
      pageCount: result.pageCount,
      pages: result.pages,
      outline: result.outline,
      outlineOrigin: result.outlineOrigin,
      parserFallbackReason: result.parserFallbackReason,
      qualityWarning: result.qualityWarning,
      usedFallbackParser: result.usedFallbackParser,
    };
    if (streamed) return res.end(`${JSON.stringify({ type: 'result', result: payload })}\n`);
    return res.json(payload);
  } catch (error) {
    console.error('[Backend] PDF text extraction failed:', error);
    if (controller.signal.aborted) return;
    return sendPdfTextFailure(res, error, streamed);
  }
});

router.post('/extract-images', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';
    const limit = readPdfImageLimit(req.body?.limit);
    const partialPages = Array.isArray(req.body?.partialPages)
      ? req.body.partialPages.filter(
          (page: unknown): page is number =>
            typeof page === 'number' && Number.isInteger(page) && page > 0
        )
      : undefined;

    if (!isPdfDataUrl(fileData)) {
      return res.status(400).json({
        success: false,
        error: PDF_DATA_URL_REQUIRED_MESSAGE,
      });
    }

    const result = await extractPdfImages(fileData, limit, partialPages);
    return res.json({
      success: true,
      failedPages: result.failedPages,
      imageCount: result.images.length,
      images: result.images,
    });
  } catch (error) {
    console.error('[Backend] PDF image extraction failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Estrazione delle immagini dal PDF non riuscita.',
    });
  }
});

export default router;
