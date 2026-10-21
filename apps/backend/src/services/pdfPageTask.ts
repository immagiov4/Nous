import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { InspectedPdfPages } from './pdfPageProcessing.mjs';
import type { ExtractedPdfText } from './pdfTextExtractor.js';
import { resolvePdfTextFallbackNodeExecutable } from './pdfTextExtractor.js';

type Inspection = { kind: 'inspect'; extracted: ExtractedPdfText };
type Render = { kind: 'render'; pageNumber: number; width: number };
interface RenderedPdfPage {
  dataUrl: string;
  width: number;
  height: number;
}

export function runPdfPageTask(
  bytes: Buffer,
  task: Inspection,
  signal: AbortSignal
): Promise<InspectedPdfPages>;
export function runPdfPageTask(
  bytes: Buffer,
  task: Render,
  signal: AbortSignal
): Promise<RenderedPdfPage>;
/** Keeps PDF.js CPU work and cleanup outside the HTTP process, including on cancellation. */
export function runPdfPageTask(
  bytes: Buffer,
  task: Inspection | Render,
  signal: AbortSignal
): Promise<InspectedPdfPages | RenderedPdfPage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const options = {
      execPath: resolvePdfTextFallbackNodeExecutable(),
      execArgv: [],
      serialization: 'json' as const,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    };
    const child = fork(
      fileURLToPath(new URL('./pdfPageProcess.mjs', import.meta.url)),
      [],
      options
    );
    let response: { result?: InspectedPdfPages | RenderedPdfPage; error?: boolean } | undefined;
    let failure: unknown;
    const abort = () => {
      failure = signal.reason;
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', abort, { once: true });
    child.on('message', message => {
      response = message as typeof response;
    });
    child.once('error', error => {
      failure ??= error;
      signal.removeEventListener('abort', abort);
      reject(error);
      child.kill('SIGKILL');
    });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || response?.error || !response?.result)
        reject(new Error('PDF page processing failed.'));
      else resolve(response.result);
    });
    child.send({ bytes: bytes.toString('base64'), task }, error => {
      if (error) {
        failure ??= error;
        child.kill('SIGKILL');
      }
    });
    if (signal.aborted) abort();
  });
}
