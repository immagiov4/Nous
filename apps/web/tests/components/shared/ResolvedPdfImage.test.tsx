// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { ProjectDocumentImageAsset } from '@shared/projectAsset';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import ResolvedPdfImage from '../../../components/shared/ResolvedPdfImage.tsx';
import { resolveProjectDocumentImage } from '../../../services/projects/projectDocumentImageResolver.ts';

vi.mock('../../../services/projects/projectDocumentImageResolver.ts', async importOriginal => ({
  ...(await importOriginal()),
  resolveProjectDocumentImage: vi.fn(),
}));

const durableImage: ProjectDocumentImageAsset = {
  asset: {
    byteSize: 4,
    hash: 'b'.repeat(64),
    id: 'a'.repeat(64),
    mediaType: 'image/png',
  },
  id: 'pdf-image-logical-1',
  sourceOrder: 1,
  textAfter: 'dopo',
  textBefore: 'prima',
};

beforeEach(() => {
  vi.clearAllMocks();
});

test('renders a durable PDF image and aborts/releases it on unmount', async () => {
  const release = vi.fn();
  vi.mocked(resolveProjectDocumentImage).mockResolvedValue({
    release,
    src: 'blob:verified-pdf-image',
  });

  const rendered = render(
    <ResolvedPdfImage alt="Schema verificato" image={durableImage} projectId="project-1" />
  );

  expect(await screen.findByRole('img', { name: 'Schema verificato' })).toHaveAttribute(
    'src',
    'blob:verified-pdf-image'
  );
  const signal = vi.mocked(resolveProjectDocumentImage).mock.calls[0]?.[0].signal;
  expect(signal?.aborted).toBe(false);

  rendered.unmount();
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(signal?.aborted).toBe(true);
});

test('releases a late result after unmount instead of exposing it', async () => {
  const release = vi.fn();
  let finish: ((result: { release: () => void; src: string }) => void) | undefined;
  vi.mocked(resolveProjectDocumentImage).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );

  const rendered = render(
    <ResolvedPdfImage alt="Schema verificato" image={durableImage} projectId="project-1" />
  );
  rendered.unmount();
  finish?.({ release, src: 'blob:late-pdf-image' });

  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(screen.queryByRole('img', { name: 'Schema verificato' })).not.toBeInTheDocument();
});

test('aborts and releases the previous image before resolving a new project', async () => {
  const firstRelease = vi.fn();
  const secondRelease = vi.fn();
  vi.mocked(resolveProjectDocumentImage)
    .mockResolvedValueOnce({ release: firstRelease, src: 'blob:first-project' })
    .mockResolvedValueOnce({ release: secondRelease, src: 'blob:second-project' });

  const rendered = render(
    <ResolvedPdfImage alt="Schema verificato" image={durableImage} projectId="project-1" />
  );
  expect(await screen.findByRole('img', { name: 'Schema verificato' })).toHaveAttribute(
    'src',
    'blob:first-project'
  );
  const firstSignal = vi.mocked(resolveProjectDocumentImage).mock.calls[0]?.[0].signal;

  rendered.rerender(
    <ResolvedPdfImage alt="Schema verificato" image={durableImage} projectId="project-2" />
  );

  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Schema verificato' })).toHaveAttribute(
      'src',
      'blob:second-project'
    )
  );
  expect(firstSignal?.aborted).toBe(true);
  expect(firstRelease).toHaveBeenCalledOnce();

  rendered.unmount();
  expect(secondRelease).toHaveBeenCalledOnce();
});

test('keeps a visible fallback when a persisted image cannot be retrieved', async () => {
  vi.mocked(resolveProjectDocumentImage).mockRejectedValue(new Error('asset unavailable'));

  render(
    <ResolvedPdfImage
      alt="Schema persistito"
      className="h-12 rounded-xl"
      image={durableImage}
      projectId="project-1"
    />
  );

  expect(await screen.findByRole('img', { name: 'Immagine non disponibile' })).toHaveClass(
    'h-12',
    'rounded-xl'
  );
});
