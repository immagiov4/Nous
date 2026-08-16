import { serialize } from 'node:v8';

import { PDFParse } from 'pdf-parse';
import {
  buildBoundedPdfTextWorkerPayload,
  PdfTextWorkerOutputLimitError,
} from './pdfTextWorkerOutput.js';

const [mode, maxOutputBytesArgument] = process.argv.slice(2);
const maxOutputBytes = maxOutputBytesArgument ? Number(maxOutputBytesArgument) : undefined;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const parser = new PDFParse({ data: Buffer.concat(chunks) });
let result;
try {
  if (mode === 'outline') {
    const info = await parser.getInfo();
    const boundedOutput = buildBoundedPdfTextWorkerPayload({
      fallbackText: '',
      maxOutputBytes,
      outline: info.outline || [],
      pages: [],
    });
    result = { outline: boundedOutput.outline };
  } else {
    const [text, info] = await Promise.all([parser.getText(), parser.getInfo().catch(() => null)]);
    result = {
      pageCount: info?.total ?? text.total,
      ...buildBoundedPdfTextWorkerPayload({
        fallbackText: text.text,
        maxOutputBytes,
        outline: info?.outline || [],
        pages: Array.isArray(text.pages) ? text.pages : [],
      }),
    };
  }
} catch (error) {
  result = {
    error: error instanceof Error ? error.message : 'PDF fallback parsing failed.',
    ...(error instanceof PdfTextWorkerOutputLimitError ? { errorCode: 'output-limit' } : {}),
  };
} finally {
  await parser.destroy().catch(() => undefined);
}

process.stdout.write(serialize(result));
