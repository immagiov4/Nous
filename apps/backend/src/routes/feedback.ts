import { type NextFunction, type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { getFeedbackService, kickFeedbackOutboxWorker } from '../services/feedbackService.js';
import {
  type FeedbackCategory,
  type FeedbackConsoleEntry,
  type FeedbackDiagnostics,
  FeedbackRateLimitError,
  type FeedbackScreenshot,
} from '../services/feedbackStore.js';
import { GithubFeedbackError } from '../services/githubFeedback.js';
import { buildSha256HexDigest } from '../utils/hash.js';
import { sanitizeDiagnosticText } from '../utils/sanitizeDiagnosticText.js';
import { isRecord, readOptionalString } from '../utils/validation.js';

const FEEDBACK_CATEGORIES = new Set<FeedbackCategory>(['bug', 'enhancement']);
const CONSOLE_LEVELS = new Set<FeedbackConsoleEntry['level']>(['debug', 'error', 'info', 'warn']);
const MAX_DESCRIPTION_LENGTH = 5_000;
const MAX_TITLE_LENGTH = 160;
const MAX_CLIENT_REQUEST_ID_LENGTH = 100;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_CONSOLE_MESSAGE_LENGTH = 1_500;
const MAX_CORRELATION_IDS = 20;
const MAX_CORRELATION_ID_LENGTH = 128;
const MAX_SCREENSHOT_BYTES = 768 * 1024;
const MAX_SCREENSHOT_WIDTH = 1_280;
const MAX_SCREENSHOT_HEIGHT = 720;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const INVALID_FEEDBACK_MESSAGE = 'Controlla i dati della segnalazione e riprova.';
const FEEDBACK_UNAVAILABLE_MESSAGE =
  'Non è stato possibile salvare la segnalazione. Riprova più tardi.';
const RATE_LIMIT_MESSAGE = 'Hai inviato troppe segnalazioni. Riprova più tardi.';
const ADMIN_REQUIRED_MESSAGE = 'Permessi di amministratore richiesti.';
const GITHUB_NOT_CONFIGURED_MESSAGE = 'La sincronizzazione GitHub non è configurata.';
const ROUTE_ID_PATTERN =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|(?:course|lesson|module|project|section|user)[-_][a-z0-9_-]{8,})$/i;

interface ParsedFeedbackInput {
  category: FeedbackCategory;
  clientRequestId?: string;
  description: string;
  diagnostics: FeedbackDiagnostics;
  screenshot?: FeedbackScreenshot;
  title?: string;
}

const sanitizeUrl = (value: unknown): string | undefined => {
  const text = readOptionalString(value);
  if (!text) {
    return undefined;
  }

  try {
    const url = new URL(text, 'https://local.nous.invalid');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    const pathname = decodeURI(url.pathname)
      .split('/')
      .map(segment =>
        ROUTE_ID_PATTERN.test(segment) ? '[ID]' : sanitizeDiagnosticText(segment, 120)
      )
      .join('/')
      .slice(0, 1_000);
    return url.origin === 'https://local.nous.invalid' ? pathname : `${url.origin}${pathname}`;
  } catch {
    return undefined;
  }
};

const sanitizeTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

const sanitizeConsoleEntries = (value: unknown): FeedbackConsoleEntry[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.slice(-MAX_CONSOLE_ENTRIES).flatMap(entry => {
    if (!isRecord(entry) || !CONSOLE_LEVELS.has(entry.level as FeedbackConsoleEntry['level'])) {
      return [];
    }
    const message =
      typeof entry.message === 'string'
        ? sanitizeDiagnosticText(entry.message, MAX_CONSOLE_MESSAGE_LENGTH)
        : '';
    if (!message) {
      return [];
    }
    const timestamp = sanitizeTimestamp(entry.timestamp);
    return [
      {
        level: entry.level as FeedbackConsoleEntry['level'],
        message,
        ...(timestamp ? { timestamp } : {}),
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
};

const sanitizeCorrelationIds = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids = [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => sanitizeDiagnosticText(entry, MAX_CORRELATION_ID_LENGTH))
        .filter(Boolean)
    ),
  ].slice(0, MAX_CORRELATION_IDS);
  return ids.length > 0 ? ids : undefined;
};

const sanitizeDiagnostics = (value: unknown, request: Request): FeedbackDiagnostics => {
  const diagnostics = isRecord(value) ? value : {};
  const pageUrl = sanitizeUrl(diagnostics.pageUrl);
  const appVersion =
    typeof diagnostics.appVersion === 'string'
      ? sanitizeDiagnosticText(diagnostics.appVersion, 64)
      : undefined;
  const requestId = sanitizeDiagnosticText(request.get('x-request-id') || '', 128) || undefined;
  const userAgent = sanitizeDiagnosticText(request.get('user-agent') || '', 300) || undefined;
  const correlationIds = sanitizeCorrelationIds(diagnostics.correlationIds);
  const consoleEntries = sanitizeConsoleEntries(diagnostics.consoleEntries);

  return {
    ...(appVersion ? { appVersion } : {}),
    ...(consoleEntries ? { consoleEntries } : {}),
    ...(correlationIds ? { correlationIds } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(requestId ? { requestId } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
};

interface ImageDimensions {
  height: number;
  width: number;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const readJpegDimensions = (bytes: Buffer): ImageDimensions | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === undefined || marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      return null;
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
};

const readWebpDimensions = (bytes: Buffer): ImageDimensions | null => {
  if (
    bytes.length < 25 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null;
  }

  const chunkType = bytes.subarray(12, 16).toString('ascii');
  if (chunkType === 'VP8X' && bytes.length >= 30) {
    return {
      height: bytes.readUIntLE(27, 3) + 1,
      width: bytes.readUIntLE(24, 3) + 1,
    };
  }
  if (chunkType === 'VP8L' && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return {
      height: ((packed >>> 14) & 0x3fff) + 1,
      width: (packed & 0x3fff) + 1,
    };
  }
  if (
    chunkType === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      height: bytes.readUInt16LE(28) & 0x3fff,
      width: bytes.readUInt16LE(26) & 0x3fff,
    };
  }
  return null;
};

const hasSafeImageDimensions = (mimeType: string, bytes: Buffer): boolean => {
  const dimensions =
    mimeType === 'image/jpeg' ? readJpegDimensions(bytes) : readWebpDimensions(bytes);
  return Boolean(
    dimensions &&
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= MAX_SCREENSHOT_WIDTH &&
      dimensions.height <= MAX_SCREENSHOT_HEIGHT
  );
};

const parseScreenshot = (value: unknown): FeedbackScreenshot | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.dataUrl !== 'string') {
    return null;
  }

  const match = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value.dataUrl);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const encoded = match[2].replaceAll(/\s/g, '');
  if (encoded.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 || encoded.length % 4 !== 0) {
    return null;
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_SCREENSHOT_BYTES ||
    !hasSafeImageDimensions(match[1], bytes)
  ) {
    return null;
  }
  return { bytes, mimeType: match[1] as FeedbackScreenshot['mimeType'] };
};

const parseFeedbackInput = (body: unknown, request: Request): ParsedFeedbackInput | null => {
  if (!isRecord(body) || !FEEDBACK_CATEGORIES.has(body.category as FeedbackCategory)) {
    return null;
  }

  const description =
    typeof body.description === 'string'
      ? sanitizeDiagnosticText(body.description, MAX_DESCRIPTION_LENGTH + 1)
      : '';
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    return null;
  }

  const title =
    typeof body.title === 'string'
      ? sanitizeDiagnosticText(body.title, MAX_TITLE_LENGTH + 1)
      : undefined;
  if (title && title.length > MAX_TITLE_LENGTH) {
    return null;
  }

  const clientRequestId = readOptionalString(body.clientRequestId);
  if (
    clientRequestId &&
    (clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH ||
      !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId))
  ) {
    return null;
  }

  const category = body.category as FeedbackCategory;
  const screenshot = category === 'bug' ? parseScreenshot(body.screenshot) : undefined;
  if (screenshot === null) {
    return null;
  }

  return {
    category,
    ...(clientRequestId ? { clientRequestId } : {}),
    description,
    diagnostics: category === 'bug' ? sanitizeDiagnostics(body.diagnostics, request) : {},
    ...(screenshot ? { screenshot } : {}),
    ...(title ? { title } : {}),
  };
};

const readPositiveInteger = (value: unknown, fallback: number, maximum?: number): number => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return maximum ? Math.min(parsed, maximum) : parsed;
};

const readRouteParameter = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] || '' : value;

const requireAdminUser = (request: Request, response: Response, next: NextFunction): void => {
  if (getCurrentUser(request).role !== 'admin') {
    response.status(403).json({ success: false, error: ADMIN_REQUIRED_MESSAGE });
    return;
  }
  next();
};

const router = Router();

router.post('/', async (request: Request, response: Response) => {
  const input = parseFeedbackInput(request.body, request);
  if (!input) {
    response.status(400).json({ success: false, error: INVALID_FEEDBACK_MESSAGE });
    return;
  }

  const currentUser = getCurrentUser(request);
  const contentHash = buildSha256HexDigest(
    Buffer.from(`${input.category}\0${input.title || ''}\0${input.description}`, 'utf8')
  );

  try {
    const submission = await getFeedbackService().submit({
      ...input,
      contentHash,
      ...(currentUser.email ? { reporterEmail: currentUser.email } : {}),
      userId: currentUser.id,
    });
    kickFeedbackOutboxWorker();
    const report = submission.report;
    response.status(submission.created ? 201 : 200).json({
      success: true,
      feedback: {
        id: report.id,
        status: report.status === 'submitted' ? 'submitted' : 'pending',
      },
    });
  } catch (error) {
    if (error instanceof FeedbackRateLimitError) {
      response.status(429).json({ success: false, error: RATE_LIMIT_MESSAGE });
      return;
    }
    console.error('[Nous][Feedback] Failed to persist feedback.', error);
    response.status(503).json({ success: false, error: FEEDBACK_UNAVAILABLE_MESSAGE });
  }
});

router.use('/admin', requireAdminUser);

router.get('/admin', async (request: Request, response: Response) => {
  const page = readPositiveInteger(request.query.page, 1);
  const pageSize = readPositiveInteger(request.query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  try {
    const result = await getFeedbackService().list(page, pageSize);
    response.set('Cache-Control', 'private, no-store');
    response.json({ success: true, page, pageSize, ...result });
  } catch (error) {
    console.error('[Nous][Feedback] Failed to list feedback.', error);
    response.status(503).json({ success: false, error: FEEDBACK_UNAVAILABLE_MESSAGE });
  }
});

router.post('/admin/sync', async (_request: Request, response: Response) => {
  try {
    const result = await getFeedbackService().syncGithub();
    response.set('Cache-Control', 'private, no-store');
    response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof GithubFeedbackError && error.code === 'github_not_configured') {
      response.status(503).json({ success: false, error: GITHUB_NOT_CONFIGURED_MESSAGE });
      return;
    }
    console.error('[Nous][Feedback] Failed to synchronize GitHub issues.', error);
    response.status(503).json({ success: false, error: FEEDBACK_UNAVAILABLE_MESSAGE });
  }
});

router.get('/admin/:id/screenshot', async (request: Request, response: Response) => {
  const feedbackId = readRouteParameter(request.params.id);
  if (!UUID_PATTERN.test(feedbackId)) {
    response.status(404).end();
    return;
  }

  try {
    const screenshot = await getFeedbackService().getScreenshot(feedbackId);
    if (!screenshot) {
      response.status(404).end();
      return;
    }
    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Type': screenshot.mimeType,
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(screenshot.bytes);
  } catch (error) {
    console.error('[Nous][Feedback] Failed to load feedback screenshot.', error);
    response.status(503).json({ success: false, error: FEEDBACK_UNAVAILABLE_MESSAGE });
  }
});

router.post('/admin/:id/retry', async (request: Request, response: Response) => {
  const feedbackId = readRouteParameter(request.params.id);
  if (!UUID_PATTERN.test(feedbackId)) {
    response.status(404).end();
    return;
  }

  try {
    if (!(await getFeedbackService().retry(feedbackId))) {
      response.status(404).end();
      return;
    }
    kickFeedbackOutboxWorker();
    response.status(202).json({ success: true });
  } catch (error) {
    console.error('[Nous][Feedback] Failed to retry feedback delivery.', error);
    response.status(503).json({ success: false, error: FEEDBACK_UNAVAILABLE_MESSAGE });
  }
});

export default router;
