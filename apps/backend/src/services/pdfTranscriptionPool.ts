import { setTimeout as delay } from 'node:timers/promises';
import { APICallError } from 'ai';
import { isRecord } from '../utils/validation.js';
import { getOperationalRetryDelayMs, readRetryAfterMs } from '../workflows/retryPolicy.js';
import {
  PdfScannedPageLimitError,
  type PdfTranscriptionSelection,
  readPdfTranscriptionPolicy,
} from './pdfTranscriptionPolicy.js';

interface RenderedPdfPage {
  dataUrl: string;
  width: number;
  height: number;
}

const DEFAULT_PDF_TRANSCRIPTION_CONCURRENCY = 32;
const readConcurrency = (): number => {
  const configured = process.env.PDF_TRANSCRIPTION_CONCURRENCY;
  const concurrency =
    configured === undefined ? DEFAULT_PDF_TRANSCRIPTION_CONCURRENCY : Number(configured);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new TypeError('PDF_TRANSCRIPTION_CONCURRENCY must be a positive integer.');
  return concurrency;
};

const readProviderFailureStatus = (error: APICallError): number | undefined => {
  if (error.statusCode === 200 && isRecord(error.data) && typeof error.data.code === 'number')
    return error.data.code;
  return error.statusCode;
};

/** One import shares request slots; a slot is reserved before rendering to bound image memory. */
export class PdfTranscriptionPool {
  private readonly controller = new AbortController();
  private readonly images = new Set<Promise<void>>();
  private readonly requests = new Set<Promise<void>>();
  private readonly imageCapacity: number;
  private readonly policy = readPdfTranscriptionPolicy();
  private scannedPages: number;
  private notBefore = 0;
  private renderedImages = 0;
  readonly progress = {
    completed: 0,
    total: 0,
    failures: [] as Array<{ documentName: string; pageNumber: number }>,
  };
  private readonly counters = { maxInFlight: 0, maxRenderedImages: 0, transientRetries: 0 };

  constructor(
    private readonly concurrency = readConcurrency(),
    previousScannedPages = 0
  ) {
    if (!Number.isSafeInteger(previousScannedPages) || previousScannedPages < 0)
      throw new TypeError('Previous scanned-page count must be a nonnegative integer.');
    this.scannedPages = previousScannedPages;
    this.imageCapacity = concurrency;
  }

  /** The source job owns one pool per course; clean pages never call this admission seam. */
  allocateScannedPages(count: number): PdfTranscriptionSelection[] {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new TypeError('Scanned-page count must be a nonnegative integer.');
    if (this.scannedPages + count > this.policy.maxScannedPages)
      throw new PdfScannedPageLimitError(this.policy.maxScannedPages);
    const selections = Array.from({ length: count }, (_, index): PdfTranscriptionSelection => {
      const ordinal = this.scannedPages + index + 1;
      const full = ordinal <= this.policy.fullQualityPages;
      return {
        ordinal,
        tier: full ? 'full' : 'reduced',
        model: full ? this.policy.fullModel : this.policy.reducedModel,
        reasoningEffort: full ? this.policy.fullEffort : this.policy.reducedEffort,
      };
    });
    this.scannedPages += count;
    return selections;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get measurements() {
    return {
      ...this.counters,
      ...this.progress,
      concurrency: this.concurrency,
      scannedPages: this.scannedPages,
      ...(this.scannedPages > this.policy.fullQualityPages
        ? {
            reducedQuality: { from: this.policy.fullQualityPages + 1, to: this.scannedPages },
          }
        : {}),
    };
  }

  private async reserve(signal: AbortSignal, request: boolean): Promise<() => void> {
    const active = request ? this.requests : this.images;
    const capacity = () => (request ? this.concurrency : this.imageCapacity);
    signal.throwIfAborted();
    while (active.size >= capacity() || (request && Date.now() < this.notBefore)) {
      if (request && Date.now() < this.notBefore) {
        await delay(this.notBefore - Date.now(), undefined, { signal });
        continue;
      }
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => rejectAbort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([Promise.race(active), aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      signal.throwIfAborted();
    }
    let release!: () => void;
    const reservation = new Promise<void>(resolve => {
      release = resolve;
    });
    active.add(reservation);
    if (request) this.counters.maxInFlight = Math.max(this.counters.maxInFlight, active.size);
    return () => {
      active.delete(reservation);
      release();
    };
  }

  private async request<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    canRetry?: () => boolean
  ): Promise<T> {
    let attemptNumber = 0;
    while (true) {
      signal.throwIfAborted();
      const release = await this.reserve(signal, true);
      try {
        return await operation();
      } catch (error) {
        const statusCode = APICallError.isInstance(error)
          ? readProviderFailureStatus(error)
          : undefined;
        if (
          canRetry?.() === false ||
          !APICallError.isInstance(error) ||
          typeof statusCode !== 'number' ||
          (statusCode !== 429 && (statusCode < 500 || statusCode > 599))
        )
          throw error;
        signal.throwIfAborted();
        attemptNumber += 1;
        this.counters.transientRetries += 1;
        const retryAfterMs = getOperationalRetryDelayMs({
          attemptNumber,
          retryAfterMs: readRetryAfterMs(error),
        });
        this.notBefore = Math.max(this.notBefore, Date.now() + retryAfterMs);
        console.warn('[Nous][PDF] Provider backoff', {
          status: statusCode,
          retryAfterMs,
          concurrency: this.concurrency,
        });
      } finally {
        release();
      }
    }
  }

  /** Returns once the image is ready, allowing the next source file to proceed during inference. */
  async schedule<T>(options: {
    render: (signal: AbortSignal) => Promise<RenderedPdfPage>;
    transcribe: (image: RenderedPdfPage, signal: AbortSignal) => Promise<T>;
    signal?: AbortSignal;
    timeoutMs: number;
    canRetry?: () => boolean;
  }): Promise<{ completion: Promise<T> }> {
    const combined = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    const release = await this.reserve(combined, false);
    const signal = AbortSignal.any([combined, AbortSignal.timeout(options.timeoutMs)]);
    try {
      const image = await options.render(signal);
      combined.throwIfAborted();
      this.renderedImages += 1;
      this.counters.maxRenderedImages = Math.max(
        this.counters.maxRenderedImages,
        this.renderedImages
      );
      const transcribe = options.transcribe;
      const completion = this.request(
        () => transcribe(image, combined),
        combined,
        options.canRetry
      ).finally(() => {
        this.renderedImages -= 1;
        release();
      });
      // Its document may still be preparing pages when this request rejects.
      void completion.catch(() => undefined);
      return { completion };
    } catch (error) {
      release();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.all([...this.images, ...this.requests]);
  }
}
