import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

type Processor = {
  wasmModule: { _process: (...args: number[]) => void };
  port: { onmessage: (event: { data: unknown[] }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

test('the installed worklet source produces identical samples for one buffer and contiguous pieces', async () => {
  const sampleRate = 48_000;
  const quantum = 128; // Web Audio render quantum.
  let Constructor: new (options: AudioWorkletNodeOptions) => Processor;
  const ready = new Set<object>();
  const environment = {
    console,
    WebAssembly,
    atob,
    performance,
    setTimeout,
    clearTimeout,
    sampleRate,
    currentTime: 0,
    registerProcessor: (_name: string, processorClass: typeof Constructor) => {
      Constructor = processorClass;
    },
    AudioWorkletProcessor: class {
      port = {
        onmessage: null,
        postMessage: (data: unknown[]) => {
          if (data[0] === 'ready') ready.add(this);
        },
      };
    },
  };
  const source = readFileSync(
    createRequire(import.meta.url).resolve('signalsmith-stretch'),
    'utf8'
  ).replace('export default _export;', '');
  runInNewContext(source, environment);
  async function createProcessor() {
    const processor = new Constructor({ numberOfOutputs: 1, outputChannelCount: [1] });
    await vi.waitFor(() => expect(ready.has(processor)).toBe(true));
    return processor;
  }
  const split = await createProcessor(),
    whole = await createProcessor();
  const message = (processor: Processor, id: number, method: string, ...args: unknown[]) =>
    processor.port.onmessage({ data: [id, method, ...args] });
  const frames = sampleRate * 3;
  const pcm = Float32Array.from(
    { length: frames },
    (_, index) => 0.2 * Math.sin(index * 0.071 + (index * index) / frames / 100)
  );
  for (let index = 0; index < 3; index++)
    message(split, index, 'addBuffers', [pcm.slice(index * sampleRate, (index + 1) * sampleRate)]);
  message(whole, 0, 'addBuffers', [pcm]);
  for (const processor of [split, whole])
    message(processor, 4, 'schedule', {
      active: true,
      input: 0,
      output: 0,
      outputTime: 0,
      rate: 1,
      semitones: 0,
    });
  let maxDifference = 0,
    energy = 0;
  for (let frame = 0; frame < frames; frame += quantum) {
    environment.currentTime = frame / sampleRate;
    const splitOutput = new Float32Array(quantum),
      wholeOutput = new Float32Array(quantum);
    split.process([[]], [[splitOutput]]);
    whole.process([[]], [[wholeOutput]]);
    for (let index = 0; index < quantum; index++) {
      maxDifference = Math.max(maxDifference, Math.abs(splitOutput[index] - wholeOutput[index]));
      energy += splitOutput[index] * splitOutput[index];
    }
  }
  expect(energy).toBeGreaterThan(0);
  expect(maxDifference).toBe(0);
  const processing = vi.spyOn(split.wasmModule, '_process');
  message(split, 5, 'stop');
  const silent = new Float32Array(quantum);
  split.process([[]], [[silent]]);
  expect([...silent]).toEqual(Array(quantum).fill(0));
  expect(processing).not.toHaveBeenCalled();
  message(split, 6, 'schedule', {
    active: true,
    input: 0,
    output: environment.currentTime,
    outputTime: environment.currentTime,
    rate: 1.5,
    semitones: 0,
  });
  split.process([[]], [[silent]]);
  expect(processing).toHaveBeenCalledExactlyOnceWith(0, quantum);
  expect(silent.some(sample => sample !== 0)).toBe(true);
});
