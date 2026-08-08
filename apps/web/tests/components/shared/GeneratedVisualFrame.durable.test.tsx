// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { ProjectLessonVisual } from '@shared/projectAsset';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import { resolveProjectVisual } from '../../../services/projects/projectVisualResolver.ts';

vi.mock('../../../services/projects/projectVisualResolver.ts', () => ({
  resolveProjectVisual: vi.fn(),
}));

const durableVisual: ProjectLessonVisual = {
  altText: 'Diagramma verificato',
  createdAt: '2026-07-29T12:00:00.000Z',
  id: 'durable-visual',
  render: {
    asset: {
      byteSize: 12,
      hash: 'b'.repeat(64),
      id: 'a'.repeat(64),
      mediaType: 'image/png',
    },
    kind: 'image',
  },
  slotId: 'slot-1',
  title: 'Diagramma',
};

test('renders a resolved durable visual and aborts/releases it on unmount', async () => {
  const release = vi.fn();
  vi.mocked(resolveProjectVisual).mockResolvedValue({
    release,
    trustedImageUrl: true,
    visual: {
      altText: 'Diagramma verificato',
      code: 'blob:verified-asset',
      createdAt: durableVisual.createdAt,
      id: durableVisual.id,
      kind: 'image',
      title: 'Diagramma',
    },
  });

  const rendered = render(
    <GeneratedVisualFrame projectId="project-1" title="Diagramma" visual={durableVisual} />
  );

  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  expect(await screen.findByRole('img', { name: 'Diagramma verificato' })).toHaveAttribute(
    'src',
    'blob:verified-asset'
  );
  const signal = vi.mocked(resolveProjectVisual).mock.calls[0]?.[0].signal;
  expect(signal?.aborted).toBe(false);

  rendered.unmount();
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(signal?.aborted).toBe(true);
});
