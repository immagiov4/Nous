import SignalsmithStretch from 'signalsmith-stretch';
import { afterEach, expect, test, vi } from 'vitest';

class WorkletNode extends EventTarget {
  port = { onmessage: (_event: { data: unknown[] }) => {}, postMessage: vi.fn() };
  constructor() {
    super();
    node = this;
  }
}
let node: WorkletNode;
const context = () => new EventTarget() as AudioContext;
afterEach(() => vi.unstubAllGlobals());

test.each([
  'processorerror',
  'wasm-error',
])('%s rejects readiness instead of leaving it pending', async failure => {
  vi.stubGlobal('AudioWorkletNode', WorkletNode);
  const pending = SignalsmithStretch(context(), {});
  const rejected = expect(pending).rejects.toThrow('Signalsmith processor failed');
  if (failure === 'processorerror') node.dispatchEvent(new Event('processorerror'));
  else node.port.onmessage({ data: ['error'] });
  await rejected;
});

test('processor failure rejects outstanding and future remote calls', async () => {
  vi.stubGlobal('AudioWorkletNode', WorkletNode);
  const pending = SignalsmithStretch(context(), {});
  node.port.onmessage({ data: ['ready', { schedule: 1 }] });
  const stretch = await pending;
  const scheduling = stretch.schedule({ active: true });
  const rejected = expect(scheduling).rejects.toThrow('Signalsmith processor failed');
  node.dispatchEvent(new Event('processorerror'));
  await rejected;
  await expect(stretch.schedule({ active: true })).rejects.toThrow('Signalsmith processor failed');
});

test('closing the context rejects pending readiness', async () => {
  vi.stubGlobal('AudioWorkletNode', WorkletNode);
  const audioContext = context();
  const pending = SignalsmithStretch(audioContext, {});
  const rejected = expect(pending).rejects.toThrow('Signalsmith processor failed');
  Object.defineProperty(audioContext, 'state', { value: 'closed' });
  audioContext.dispatchEvent(new Event('statechange'));
  await rejected;
});
