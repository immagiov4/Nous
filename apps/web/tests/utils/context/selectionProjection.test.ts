import { afterEach, expect, test, vi } from 'vitest';
import { projectSelectionContent } from '../../../utils/context/selectionProjection.ts';

let worker: WorkerDouble;
class WorkerDouble {
  onmessage?: (event: MessageEvent<string>) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    worker = this;
  }
}
const installWorker = () => vi.stubGlobal('Worker', WorkerDouble);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('passes the complete Unicode source to the worker and returns its projection unchanged', async () => {
  installWorker();
  const content = 'café cafe\u0301 日本語 👩🏽‍🔬 $\\alpha$';
  const projected = 'café cafe\u0301 日本語 👩🏽‍🔬 α';
  const result = projectSelectionContent(content, new AbortController().signal);
  expect(worker.postMessage).toHaveBeenCalledWith(content);
  worker.onmessage?.({ data: projected } as MessageEvent<string>);
  await expect(result).resolves.toBe(projected);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

test('terminates cancelled work and rejects without delivering an obsolete result', async () => {
  installWorker();
  const controller = new AbortController();
  const result = projectSelectionContent('lesson', controller.signal);
  controller.abort();
  worker.onmessage?.({ data: 'obsolete projection' } as MessageEvent<string>);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

test('propagates worker failures and terminates the worker', async () => {
  installWorker();
  const result = projectSelectionContent('lesson', new AbortController().signal);
  worker.onerror?.({ message: 'Failed to load worker' } as ErrorEvent);
  await expect(result).rejects.toThrow('Failed to load worker');
  expect(worker.terminate).toHaveBeenCalledOnce();
});
