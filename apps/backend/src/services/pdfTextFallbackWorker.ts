import { parentPort, workerData } from 'node:worker_threads';

import { PDFParse } from 'pdf-parse';
import {
  buildBoundedPdfTextWorkerPayload,
  PdfTextWorkerOutputLimitError,
} from './pdfTextWorkerOutput.js';

interface PdfTextWorkerInput {
  bytes: Uint8Array;
  maxOutputBytes?: number;
  mode: 'fallback' | 'outline';
}

const input = workerData as PdfTextWorkerInput;
const parser = new PDFParse({
  data: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
});

try {
  if (input.mode === 'outline') {
    const info = await parser.getInfo();
    const boundedOutput = buildBoundedPdfTextWorkerPayload({
      fallbackText: '',
      maxOutputBytes: input.maxOutputBytes,
      outline: info.outline || [],
      pages: [],
    });
    parentPort?.postMessage({ outline: boundedOutput.outline });
  } else {
    const [text, info] = await Promise.all([parser.getText(), parser.getInfo().catch(() => null)]);
    parentPort?.postMessage({
      pageCount: info?.total ?? text.total,
      ...buildBoundedPdfTextWorkerPayload({
        fallbackText: text.text,
        maxOutputBytes: input.maxOutputBytes,
        outline: info?.outline || [],
        pages: Array.isArray(text.pages) ? text.pages : [],
      }),
    });
  }
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'PDF fallback parsing failed.',
    ...(error instanceof PdfTextWorkerOutputLimitError ? { errorCode: 'output-limit' } : {}),
  });
} finally {
  await parser.destroy().catch(() => undefined);
}
