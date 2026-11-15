import { type ReactNode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { atlasStageReady } from '../../../../e2e/nous/atlas/dom';
import { segmentLessonPlayback } from '../../../../packages/shared-types/lessonPlayback';
import ResolvedPdfImage from '../../components/shared/ResolvedPdfImage';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import imageUrl from '../../public/icons/nous-app-icon-mask-512.png?url';
import '../../styles/app.css';

declare global {
  interface Window {
    imageGeometryReady: typeof atlasStageReady;
    imageGeometryInitial: number[][];
  }
}

function GeometryProbe({ children, surface }: { children: ReactNode; surface: string }) {
  useLayoutEffect(() => {
    const playback = surface === 'playback';
    window.imageGeometryInitial = Array.from(
      document.querySelectorAll(playback ? '.scene-fit, .scene-host figure' : '#root > div > *'),
      element => {
        const box = element.getBoundingClientRect();
        return [box.left, box.top, box.width, box.height].map(Math.round);
      }
    );
  }, [surface]);
  return children;
}

async function render() {
  Object.assign(globalThis, {
    __NOUS_RUNTIME_CONFIG__: { authMode: 'local-bypass', backendUrl: location.origin },
  });
  const bytes = await (await fetch(imageUrl)).arrayBuffer();
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const asset = {
    id: 'fixture-image',
    asset: {
      id: 'a'.repeat(64),
      hash,
      byteSize: bytes.byteLength,
      mediaType: 'image/png' as const,
    },
    intrinsicWidth: image.naturalWidth,
    intrinsicHeight: image.naturalHeight,
    sourceOrder: 0,
    textBefore: '',
    textAfter: '',
  };
  const sources = [
    { type: 'markdown' as const, markdown: 'Observe the image.\n\n{{PDF_IMAGE:fixture-image}}' },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const params = new URLSearchParams(location.search);
  document.documentElement.classList.toggle('dark', params.has('dark'));
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root must exist');
  window.imageGeometryReady = atlasStageReady;
  const surface = params.get('surface') ?? 'playback';
  await document.fonts.load('400 16px Inter');
  await document.fonts.load('700 13px Inter');
  const reader: Partial<WorkspaceReaderContentModel> = {
    projectId: 'image-geometry',
    sectionContentBlocks: sources,
    activeSectionAssetsById: { 'fixture-image': asset },
    isDarkMode: params.has('dark'),
  };
  const content =
    surface === 'playback' ? (
      <div style={{ height: '100dvh', display: 'flex' }}>
        <LessonPlaybackStage
          block={block}
          duration={30}
          time={15}
          content={reader as WorkspaceReaderContentModel}
        />
      </div>
    ) : (
      <div style={{ width: '80vw', margin: 'auto' }}>
        <ResolvedPdfImage
          image={asset}
          projectId="image-geometry"
          alt="Synthetic image"
          className={
            surface === 'thumbnail'
              ? 'h-12 w-full rounded-xl object-cover'
              : 'mx-auto block max-h-[72dvh] max-w-full rounded-xl object-contain'
          }
        />
      </div>
    );
  createRoot(root).render(<GeometryProbe surface={surface}>{content}</GeometryProbe>);
}
void render();
