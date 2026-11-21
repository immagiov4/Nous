import { buildAlgorithmLayout } from '@shared/lessonStudios/algorithmLayout';
import { isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';
import { decodeStudioDraft } from '../../../src/services/lessonScenes/lessonStudioSelection';

const narration = 'Confrontiamo tre e quattro. Il passaggio senza scambi conferma l’ordine.';
const sorting = {
  type: 'algorithm',
  studio: 'array-algorithm',
  spec: { algorithm: 'bubble', input: [3, 4], callouts: [] },
};

test.each([
  { width: 403, height: 204.71875 },
  { width: 274, height: 139.1875 },
])('renders the approved sort operands at 14 CSS px on a $width px reader stage', viewport => {
  const scene = decodeStudioDraft(sorting, narration, []);
  assert(scene);
  const layout = buildAlgorithmLayout(scene, viewport);
  layout.seek(0);
  const [, , width, height] = String(layout.surface.attrs.viewBox).split(' ').map(Number);
  const paintedScale = Math.min(viewport.width / width, viewport.height / height);
  const operands = [...descendants(layout.surface)].filter(
    node => node.label?.style === 'array-value' && isVisible(node)
  );
  expect(operands.map(node => node.textContent)).toEqual(['3', '4']);
  for (const operand of operands)
    expect((operand.label?.size ?? 0) * paintedScale).toBeGreaterThanOrEqual(14);
});

test('keeps the complete published heap tree inside a height-limited playback stage', () => {
  const text = 'Costruiamo un max-heap dai valori. Il valore più grande diventa la radice.';
  const scene = decodeStudioDraft(
    {
      type: 'algorithm',
      studio: 'heap',
      spec: { input: [4, 3], operation: 'build', beats: [] },
    },
    text,
    []
  );
  assert(scene);
  const layout = buildAlgorithmLayout(scene, { width: 137, height: 69.59375 });
  layout.seek(0, true);
  const [, top, , height] = String(layout.surface.attrs.viewBox).split(' ').map(Number);
  const nodes = [...descendants(layout.surface)].filter(
    node => node.hasClass('heap-node') && isVisible(node)
  );
  expect(nodes).toHaveLength(2);
  for (const node of nodes)
    expect(node.y + node.children[0].number('r')).toBeLessThanOrEqual(top + height);
});
