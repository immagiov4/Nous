import { parentPort, workerData } from 'node:worker_threads';

import { PDFParse } from 'pdf-parse';

interface PdfTextWorkerInput {
  bytes: Uint8Array;
  mode: 'fallback' | 'outline';
}

const input = workerData as PdfTextWorkerInput;
const parser = new PDFParse({
  data: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
});

try {
  if (input.mode === 'outline') {
    const info = await parser.getInfo();
    parentPort?.postMessage({ outline: info.outline || [] });
  } else {
    const [text, info] = await Promise.all([parser.getText(), parser.getInfo().catch(() => null)]);
    parentPort?.postMessage({
      outline: info?.outline || [],
      pageCount: info?.total ?? text.total,
      pages: Array.isArray(text.pages)
        ? text.pages.map(page => ({ pageNumber: page.num, text: page.text }))
        : [],
      text: text.text,
    });
  }
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'PDF fallback parsing failed.',
  });
} finally {
  await parser.destroy().catch(() => undefined);
}
