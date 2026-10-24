import { getPlaybackFormulaSources, segmentLessonPlayback } from '@shared/lessonPlayback';
import { expect, test } from 'vitest';

test('reuses formula syntax across passages within a long-task budget and refreshes edited sources', () => {
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
  expect(getPlaybackFormulaSources(explanations[0], sources)).toEqual(['$$x=1$$']);
  const start = performance.now();
  const formulas = explanations
    .slice(1, 21)
    .map(block => getPlaybackFormulaSources(block, sources));
  const elapsed = performance.now() - start;
  expect(formulas).toEqual(Array.from({ length: 20 }, () => ['$$x=1$$']));
  // A batch of already analysed passage lookups must not form a main-thread long task.
  const longTaskBudgetMs = 50;
  expect(elapsed).toBeLessThan(longTaskBudgetMs);
  source.markdown = source.markdown.replace('x=1', 'y=2');
  expect(getPlaybackFormulaSources(explanations[1], sources)).toEqual(['$$y=2$$']);
  expect(getPlaybackFormulaSources(explanations[0], sources)).toEqual(['$$y=2$$']);
  const replacement = [{ ...source, markdown: source.markdown.replace('y=2', 'z=3') }];
  expect(getPlaybackFormulaSources(explanations[1], replacement)).toEqual(['$$z=3$$']);
});
