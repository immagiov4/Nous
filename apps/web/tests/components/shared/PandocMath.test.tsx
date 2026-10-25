// @vitest-environment jsdom

import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { getRenderedMathSourceRanges } from '@shared/markdownMathNormalization';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SceneText } from '../../../components/shared/lessonScene/SceneText';
import MarkdownRenderer from '../../../components/shared/MarkdownRenderer';
import { captionFormat, captionSource } from '../../../components/workspace/playback/captionFormat';

const cases = [
  ['$5 today and $10 tomorrow', '$5 today and $10 tomorrow', []],
  ['$x^2$', '[x^2]', ['x^2']],
  ['costs $20,000 and $x$', 'costs $20,000 and [x]', ['x']],
  [String.raw`\$5`, '$5', []],
  ['$ x$', '$ x$', []],
  ['$x $', '$x $', []],
  ['$x$2', '$x$2', []],
  ['$x!$表示', '[x!]表示', ['x!']],
  ['$5:$x$', '[5:]x$', ['5:']],
  ['$5、$x$', '[5、]x$', ['5、']],
  ['$5 ($x$)', '[5 (]x$)', ['5 (']],
  [String.raw`\(x^2\)`, '[x^2]', ['x^2']],
  [String.raw`\(x\)2`, '[x]2', ['x']],
  [String.raw`$x+\$5$`, String.raw`[x+\$5]`, [String.raw`x+\$5`]],
  ['$x$$y$', '[x][y]', ['x', 'y']],
  ['$$x^2$$', '[x^2]', ['x^2']],
  [String.raw`\[x^2\]`, '[x^2]', ['x^2']],
] as const;

for (const [source, visible, math] of cases) {
  test(`renders the Pandoc contract across scene and Markdown: ${source}`, () => {
    for (const element of [
      <SceneText key="scene">{source}</SceneText>,
      <MarkdownRenderer key="markdown" content={source} />,
    ]) {
      const { container, unmount } = render(element);
      expect([...container.querySelectorAll('annotation')].map(node => node.textContent)).toEqual(
        math
      );
      const copy = container.cloneNode(true) as HTMLElement;
      for (const formula of copy.querySelectorAll('.katex')) {
        formula.replaceWith(`[${formula.querySelector('annotation')?.textContent}]`);
      }
      expect(copy.textContent).toBe(visible);
      unmount();
    }
  });
}

test('source projection preserves prices and recognizes only eligible dollar math', () => {
  const source = 'costs $20,000 and $x$';
  expect(
    getRenderedMathSourceRanges(source).map(range => source.slice(range.start, range.end))
  ).toEqual(['$x$']);
  const block = segmentLessonPlayback([
    { type: 'markdown', markdown: '$5 today and $10 tomorrow' },
  ])[0];
  expect(block.speech).toBe('$5 today and $10 tomorrow');
  expect(block.spans.some(span => span.math)).toBe(false);
  const sources = [{ type: 'markdown' as const, markdown: '$5 today and $10 tomorrow' }];
  const captions = captionSource(block, sources);
  expect(
    captionFormat(captions.markdown, captions.ranges)
      .words.map(word => word.text)
      .join(' ')
  ).toBe('$5 today and $10 tomorrow');
});

test.each([
  '$$x^2$$',
  '$$\nx^2\n$$',
  String.raw`\[x^2\]`,
  '\\[\nx^2\n\\]',
])('keeps display math in display style: %s', source => {
  for (const element of [
    <SceneText key="scene">{source}</SceneText>,
    <MarkdownRenderer key="markdown" content={source} />,
  ]) {
    const { container, unmount } = render(element);
    expect(container.querySelectorAll('math[display="block"]')).toHaveLength(1);
    expect(container.querySelector('annotation')?.textContent?.trim()).toBe('x^2');
    unmount();
  }
});

test('keeps dollars literal inside authored Markdown code', () => {
  const { container } = render(<MarkdownRenderer content={'`$x$`\n\n```text\n$x^2$\n```'} />);
  expect(container.querySelectorAll('math')).toHaveLength(0);
  expect(container.querySelector('code')?.textContent).toBe('$x$');
  expect(container.textContent).toContain('$x^2$');
});

test('does not recognize display math across a blank line', () => {
  const source = '$$x\n\nx$$';
  for (const element of [
    <SceneText key="scene">{source}</SceneText>,
    <MarkdownRenderer key="markdown" content={source} />,
  ]) {
    const { container, unmount } = render(element);
    expect(container.querySelectorAll('math')).toHaveLength(0);
    unmount();
  }
});
