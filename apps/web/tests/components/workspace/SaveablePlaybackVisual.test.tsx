// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { SaveablePlaybackVisual } from '../../../components/workspace/playback/SaveablePlaybackVisual.tsx';
import type { WorkspaceReaderContentModel } from '../../../components/workspace/shell/types.ts';
import { setAccountLocale } from '../../../i18n/uiMessages.ts';
import type { StoredLessonVisual } from '../../../types.ts';
import { createDeferred } from '../../helpers/deferred.ts';

const scene: LessonScene = {
  type: 'quote',
  title: 'Memoria',
  body: '',
  note: '',
  items: [],
  groups: [],
  quote: 'Conserva i dati.',
};
const sources = [{ type: 'markdown' as const, markdown: 'La memoria conserva i dati.' }];
const block = { ...segmentLessonPlayback(sources)[0], heading: 'Memoria' };
const save = vi.fn();
const remove = vi.fn();

function Subject({ fail = false, saveGate }: { fail?: boolean; saveGate?: Promise<void> }) {
  const [visuals, setVisuals] = useState<Record<string, StoredLessonVisual>>(() =>
    JSON.parse(localStorage.getItem('saved-visual-test') ?? '{}')
  );
  const content = {
    projectId: 'course',
    activeSectionId: 'lesson',
    sectionContent: sources[0].markdown,
    sectionContentBlocks: sources,
    activeSectionGeneratedVisualsById: visuals,
    onSavePlaybackVisual: async (
      ...args: Parameters<NonNullable<WorkspaceReaderContentModel['onSavePlaybackVisual']>>
    ) => {
      save(...args);
      await saveGate;
      if (fail) return { succeeded: false, error: 'Salvataggio fallito' };
      const next = { ...visuals, [args[1].id]: args[1] };
      localStorage.setItem('saved-visual-test', JSON.stringify(next));
      setVisuals(next);
      return { succeeded: true };
    },
    onRemovePlaybackVisual: async (target: unknown, id: string) => {
      remove(target, id);
      const next = { ...visuals };
      delete next[id];
      localStorage.setItem('saved-visual-test', JSON.stringify(next));
      setVisuals(next);
      return { succeeded: true };
    },
  } as WorkspaceReaderContentModel;
  return (
    <SaveablePlaybackVisual scene={scene} block={block} content={content} cardRef={useRef(null)}>
      <p>Conserva i dati.</p>
    </SaveablePlaybackVisual>
  );
}

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setAccountLocale(null);
});

test('renders the action only during hover, focus or touch discovery', () => {
  setAccountLocale('it');
  render(<Subject />);
  const visual = screen.getByRole('region', { name: 'Visualizzazione della lezione' });
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.mouseEnter(visual);
  expect(screen.getByRole('button', { name: 'Salva' }).textContent).toBe('Salva');
  fireEvent.mouseLeave(visual);
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.focus(visual);
  expect(screen.getByRole('button', { name: 'Salva' }).textContent).toBe('Salva');
  fireEvent.blur(visual, { relatedTarget: document.body });
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.pointerDown(visual, { pointerType: 'touch' });
  expect(screen.getByRole('button', { name: 'Salva' }).textContent).toBe('Salva');
});

test('saves exact scene and passage, restores remove after remount, then removes', async () => {
  setAccountLocale('it');
  const first = render(<Subject />);
  fireEvent.mouseEnter(screen.getByRole('region'));
  fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
  await screen.findByRole('button', { name: 'Rimuovi' });
  const [target, visual, artifact, passage] = save.mock.calls[0];
  expect(target).toEqual({ projectId: 'course', lessonId: 'lesson' });
  expect(visual).toMatchObject({
    title: 'Memoria',
    kind: 'scene',
    code: '',
    scene,
    anchorHeading: 'Memoria',
  });
  expect(artifact).toEqual({
    artifactId: `course:lesson:generated-visual:${visual.id}`,
    title: 'Memoria',
    kind: 'generated-visual',
  });
  expect(passage).toMatchObject({ exact: 'La memoria conserva i dati.', start: 0, end: 27 });
  first.unmount();
  render(<Subject />);
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.focus(screen.getByRole('region'));
  fireEvent.click(screen.getByRole('button', { name: 'Rimuovi' }));
  await screen.findByRole('button', { name: 'Salva' });
  expect(remove).toHaveBeenCalledWith(target, visual.id);
  expect(JSON.parse(localStorage.getItem('saved-visual-test') ?? 'null')).toEqual({});
});

test('failed persistence retains save and exposes a recoverable error', async () => {
  setAccountLocale('it');
  render(<Subject fail />);
  fireEvent.mouseEnter(screen.getByRole('region'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salva' })));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Salvataggio fallito'));
  expect(screen.getByRole('button', { name: 'Salva' }).getAttribute('aria-disabled')).toBe('false');
});

test('pending save retains keyboard focus and ignores duplicate activation', async () => {
  setAccountLocale('it');
  const gate = createDeferred();
  render(<Subject saveGate={gate.promise} />);
  act(() => screen.getByRole('region').focus());
  const button = screen.getByRole('button', { name: 'Salva' });
  act(() => button.focus());
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(button);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][1]).toMatchObject({ kind: 'scene', scene });
  await act(async () => gate.resolve());
  await screen.findByRole('button', { name: 'Rimuovi' });
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-disabled')).toBe('false');
});
