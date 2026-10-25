import { getPlaybackFormulaSources, segmentLessonPlayback } from '@shared/lessonPlayback';
import { unified } from 'unified';
import { expect, test, vi } from 'vitest';

test('reuses formula syntax across passages and refreshes edited or replaced sources', () => {
  const processor = Object.getPrototypeOf(unified()) as typeof unified;
  const parse = vi.spyOn(processor, 'parse');
  const prose = Array.from(
    { length: 100 },
    (_, index) =>
      `Passaggio ${index}: la formula descrive una relazione tra le grandezze del modello e mantiene il significato della spiegazione.`
  ).join('\n\n');
  const source = { type: 'markdown' as const, markdown: `# Formula\n\n$$x=1$$\n\n${prose}` };
  const sources = [source];
  const explanations = segmentLessonPlayback(sources).filter(block =>
    block.speech.startsWith('Passaggio')
  );
  parse.mockClear();
  expect(getPlaybackFormulaSources(explanations[0], sources)).toEqual(['$$x=1$$']);
  expect(parse.mock.calls.filter(([input]) => input === source.markdown)).toHaveLength(1);
  parse.mockClear();
  const formulas = explanations
    .slice(1, 21)
    .map(block => getPlaybackFormulaSources(block, sources));
  expect(formulas).toEqual(Array.from({ length: 20 }, () => ['$$x=1$$']));
  expect(parse.mock.calls.filter(([input]) => input === source.markdown)).toHaveLength(0);
  source.markdown = source.markdown.replace('x=1', 'y=2');
  expect(getPlaybackFormulaSources(explanations[1], sources)).toEqual(['$$y=2$$']);
  expect(getPlaybackFormulaSources(explanations[0], sources)).toEqual(['$$y=2$$']);
  expect(parse.mock.calls.filter(([input]) => input === source.markdown)).toHaveLength(1);
  const replacement = [{ ...source, markdown: source.markdown.replace('y=2', 'z=3') }];
  expect(getPlaybackFormulaSources(explanations[1], replacement)).toEqual(['$$z=3$$']);
  expect(parse.mock.calls.filter(([input]) => input === replacement[0].markdown)).toHaveLength(1);
});
