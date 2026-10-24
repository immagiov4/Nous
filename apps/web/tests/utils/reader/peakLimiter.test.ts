import { expect, test } from 'vitest';
import { PeakLimiter } from '../../../utils/reader/peakLimiter';

test('lookahead preserves safe samples and bounds abrupt stereo peaks without flattening them', () => {
  const limiter = new PeakLimiter();
  const render = (amplitude: number) => {
    const left = Float32Array.from({ length: 128 }, (_, i) => amplitude * Math.sin(i * 0.17));
    const right = Float32Array.from(left, sample => -sample / 2);
    const output = [new Float32Array(128), new Float32Array(128)];
    limiter.process([left, right], output);
    return { left, output };
  };
  const safe = render(0.5);
  expect([...safe.output[0]]).toEqual(Array(128).fill(0));
  expect([...render(0.5).output[0]]).toEqual([...safe.left]);
  for (const amplitude of [4, 0.5, 2, 0, 0, 3, 0.5]) {
    const { output } = render(amplitude);
    expect(Math.max(...output.flatMap(channel => [...channel].map(Math.abs)))).toBeLessThanOrEqual(
      1
    );
    expect([...output[1]]).toEqual([...output[0]].map(sample => -sample / 2));
  }
});
