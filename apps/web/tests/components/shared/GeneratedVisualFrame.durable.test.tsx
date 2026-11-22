// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { GeometryLessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual.tsx';
import { algorithmRenderer } from '../../../components/shared/lessonScene/studios/algorithmRenderer.ts';
import { useStudioImageAsset } from '../../../components/shared/lessonScene/studios/useStudioImageAsset.ts';
import {
  resolveProjectImageAsset,
  resolveProjectVisual,
} from '../../../services/projects/projectVisualResolver.ts';
import { createDeferred } from '../../helpers/deferred.ts';

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

function annotationScene(): GeometryLessonScene {
  const { render: visual } = durableVisual;
  if (visual.kind !== 'image') throw new Error('Expected fixture raster');
  return {
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
}

test('waits for raster decode before drawing the first standalone frame', async () => {
  const initial = annotationScene();
  const { geometryStudio } = initial;
  if (geometryStudio.id !== 'image-annotate') throw new Error('Expected annotation fixture');
  const scene = {
    ...initial,
    narration: 'Osserva il diagramma. Poi guarda il centro.',
    studioCues: [{ anchor: 'Osserva il diagramma.' }, { anchor: 'Poi guarda il centro.' }],
    geometryStudio: {
      ...geometryStudio,
      spec: { ...geometryStudio.spec, beats: [{ at: 'b1' }, { at: 'b2', label: 'Il centro' }] },
    },
  };
  const decoding = createDeferred();
  const decode = vi.fn(() => decoding.promise);
  vi.stubGlobal(
    'Image',
    class {
      decode = decode;
    }
  );
  const observe = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = observe;
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 600, 300)
  );
  vi.mocked(resolveProjectImageAsset).mockResolvedValueOnce({
    url: 'blob:delayed',
    release: vi.fn(),
  });
  const { container } = render(<LessonSceneVisual scene={scene} projectId="project-1" />);

  await waitFor(() =>
    expect(resolveProjectImageAsset).toHaveBeenCalledWith(
      'project-1',
      scene.geometryStudio.asset,
      expect.any(AbortSignal)
    )
  );
  expect(container.querySelector('.image-annotation')).toHaveAttribute('aria-busy', 'true');
  expect(container.querySelector('.image-annotation-chart')).toBeNull();
  expect(observe).not.toHaveBeenCalled();

  await act(async () => decoding.resolve());
  expect(decode).toHaveBeenCalledOnce();
  expect(container.querySelector('.image-annotation-chart image')).toHaveAttribute(
    'href',
    'blob:delayed'
  );
  expect(container.querySelector('.image-annotation-label title')?.textContent).not.toBe(
    'Il centro'
  );
  expect(observe).toHaveBeenCalledOnce();
});

test('keeps one image drawing when the stage resizes twice before playback', () => {
  const scene = annotationScene();
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
  vi.stubGlobal(
    'Image',
    class {
      decode = async () => {};
    }
  );
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
