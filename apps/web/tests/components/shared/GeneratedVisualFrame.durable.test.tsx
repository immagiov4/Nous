// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { GeometryLessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import { algorithmRenderer } from '../../../components/shared/lessonScene/studios/algorithmRenderer.ts';
import { useStudioImageAsset } from '../../../components/shared/lessonScene/studios/useStudioImageAsset.ts';
import {
  resolveProjectImageAsset,
  resolveProjectVisual,
} from '../../../services/projects/projectVisualResolver.ts';

vi.mock('../../../services/projects/projectVisualResolver.ts', () => ({
  resolveProjectVisual: vi.fn(),
  resolveProjectImageAsset: vi.fn(),
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

test('keeps one image drawing when the stage resizes twice before playback', () => {
  const { render: visual } = durableVisual;
  if (visual.kind !== 'image') throw new Error('Expected fixture raster');
  const scene: GeometryLessonScene = {
    type: 'geometry',
    title: 'Diagramma',
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true,
    narration: 'Osserva il centro.',
    studioCues: [{ anchor: 'Osserva il centro.' }],
    geometryStudio: {
      id: 'image-annotate',
      asset: { ...visual.asset, mediaType: 'image/png' },
      spec: {
        title: 'Diagramma',
        alt: 'Un diagramma di riferimento',
        image: {
          title: 'Example.png',
          source: 'https://commons.wikimedia.org/wiki/File:Example.png',
          author: 'Author',
          license: 'Public domain',
          licenseUrl: '',
          width: 640,
          height: 480,
        },
        beats: [{ at: 'b1', label: 'Il centro' }],
      },
    },
  };
  const host = document.createElement('div');
  let width = 1000;
  let resize = () => {};
  vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 508));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(onResize: () => void) {
        resize = onResize;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.useFakeTimers();
  const renderer = algorithmRenderer(host, scene, false, 'blob:verified-asset');
  try {
    resize();
    vi.advanceTimersToNextFrame();
    width = 900;
    resize();
    vi.advanceTimersToNextFrame();
    renderer.render({ durationMs: 2000, elapsedMs: 1000 });

    const drawings = [...host.querySelectorAll('[data-studio="image-annotate"] > svg')];
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toHaveAttribute('viewBox', '0 0 900 508');
    expect(drawings[0].querySelector('image')).toHaveAttribute('href', 'blob:verified-asset');
  } finally {
    renderer.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test('opens the stored annotation raster and replaces its URL on regeneration', async () => {
  const { render: visual } = durableVisual;
  if (visual.kind !== 'image') throw new Error('Expected fixture raster');
  const nextAsset = { ...visual.asset, id: 'd'.repeat(64) };
  const releaseFirst = vi.fn();
  const releaseSecond = vi.fn();
  const resolver = vi.mocked(resolveProjectImageAsset);
  resolver
    .mockResolvedValueOnce({ url: 'blob:original', release: releaseFirst })
    .mockResolvedValueOnce({ url: 'blob:replacement', release: releaseSecond });
  const { result, rerender, unmount } = renderHook(
    ({ asset }) => useStudioImageAsset(asset, 'project-1'),
    { initialProps: { asset: visual.asset } }
  );
  await waitFor(() => expect(result.current.url).toBe('blob:original'));
  const firstSignal = resolver.mock.calls[0]?.[2];
  expect(resolver).toHaveBeenNthCalledWith(1, 'project-1', visual.asset, firstSignal);
  rerender({ asset: nextAsset });
  expect(result.current.url).toBeUndefined();
  expect(firstSignal?.aborted).toBe(true);
  expect(releaseFirst).toHaveBeenCalledOnce();
  await waitFor(() => expect(result.current.url).toBe('blob:replacement'));
  expect(resolver).toHaveBeenNthCalledWith(2, 'project-1', nextAsset, expect.any(AbortSignal));
  unmount();
  expect(releaseSecond).toHaveBeenCalledOnce();
});

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
