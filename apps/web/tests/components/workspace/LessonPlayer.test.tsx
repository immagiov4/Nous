// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, StrictMode } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import LessonPlayer from '../../../components/workspace/playback/LessonPlayer.tsx';
import type {
  WorkspaceReaderContentModel,
  WorkspaceReaderOverlaysModel,
} from '../../../components/workspace/shell/types.ts';
import { useLessonPlayback } from '../../../hooks/reader/useLessonPlayback.ts';
import { setAccountLocale } from '../../../i18n/uiMessages.ts';
import { requestSpeechTranscription } from '../../../services/openrouter/sttClient.ts';

const sendInConversation = vi.hoisted(() => vi.fn());
const generatingResponse = vi.hoisted(() => ({ stop: null as null | (() => void) }));
const answerPreview = vi.hoisted(() => ({ open: false }));
const answerPanelProps = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/reader/useLessonPlayback.ts', () => ({ useLessonPlayback: vi.fn() }));
vi.mock('../../../components/workspace/playback/LessonPlaybackStage.tsx', () => ({
  default: () => <div />,
}));
vi.mock('../../../services/openrouter/sttClient.ts', () => ({
  requestSpeechTranscription: vi.fn(),
}));
vi.mock('../../../components/workspace/shell/ContextAnswerPanel.tsx', () => ({
  default: (
    props: ComponentProps<
      typeof import('../../../components/workspace/shell/ContextAnswerPanel.tsx').default
    >
  ) => {
    answerPanelProps(props);
    const { onClose, contextAnswer, pendingQuestion, renderComposer } = props;
    return (
      <div>
        <p>{pendingQuestion ? 'Trascrizione domanda' : contextAnswer.initialQuestion}</p>
        <button type="button" onClick={onClose}>
          Chiudi risposta
        </button>
        {renderComposer?.(sendInConversation, false, generatingResponse.stop ?? undefined)}
        {answerPreview.open
          ? createPortal(
              <div role="dialog" aria-label="Anteprima">
                Figura ingrandita
              </div>,
              document.body
            )
          : null}
      </div>
    );
  },
}));

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = () => true;
  readonly mimeType = 'audio/webm';
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Recorder.instances.push(this);
  }
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['question']) });
    this.onstop?.();
  });
}
const getUserMedia = vi.fn();
const stopTrack = vi.fn();
const space = { key: ' ', code: 'Space' };
const recordQuestion = async () => {
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await waitFor(() => expect(Recorder.instances.at(-1)?.state).toBe('recording'));
  fireEvent.keyUp(window, space);
  await screen.findByText('Perché funziona?');
};

const source = [{ type: 'markdown' as const, markdown: 'La prima frase. La seconda frase.' }];
const blocks = segmentLessonPlayback(source);
const content = {
  sectionContent: source[0].markdown,
  sectionContentBlocks: source,
  activeSectionTitle: 'Lezione',
  isDarkMode: false,
  isMobileViewport: false,
  activeSectionAssetsById: {},
  activeSectionImageRefsById: {},
} as WorkspaceReaderContentModel;
const tts: ComponentProps<typeof LessonPlayer>['tts'] = {
  currentVoice: 'Kore',
  playbackRate: 1,
  availableVoices: [{ id: 'Kore', label: 'Voce 1', language: 'it' }],
  onVoiceChange: vi.fn(),
  onSpeedChange: vi.fn(),
};
const save = vi.fn<WorkspaceReaderOverlaysModel['onSaveConversationNote']>();
const overlays: ComponentProps<typeof LessonPlayer>['overlays'] = {
  onUpdateConversationNote: vi.fn(),
  onOpenLibraryReference: vi.fn(),
  libraryAssistantDataSource: {
    attachedContextRefs: [],
    folders: [],
    projects: [],
    loadProjectsById: vi.fn(),
    tree: {
      descendantProjectIdsByFolderId: {},
      folderById: {},
      placementByProjectId: {},
      rootNodes: [],
    },
  },
  onSaveConversationNote: save,
  contextAnswerSize: { width: 480, height: 400 },
};
const props = {
  sectionId: 'lesson',
  projectId: 'project',
  content,
  overlays,
  tts,
  onClose: vi.fn(),
};
let playback: ReturnType<typeof useLessonPlayback>;

beforeEach(() => {
  setAccountLocale('it');
  sendInConversation.mockReset();
  generatingResponse.stop = null;
  answerPreview.open = false;
  answerPanelProps.mockClear();
  Recorder.instances = [];
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  stopTrack.mockReset();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.mocked(requestSpeechTranscription).mockReset().mockResolvedValue('Perché funziona?');
  playback = {
    blocks,
    index: 0,
    time: 0,
    duration: 12,
    elapsed: 0,
    total: 12,
    estimated: false,
    playing: true,
    loading: false,
    failed: false,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    seek: vi.fn(),
    readTime: vi.fn(() => 0),
  };
  vi.mocked(useLessonPlayback).mockImplementation(() => playback);
  save.mockResolvedValue({ saved: true, merged: false, annotationId: 'annotation' });
});

test.each([
  undefined,
  true,
])('starts on open with autoPlay=%s and displays preparation', autoPlay => {
  playback = { ...playback, playing: false, loading: true };
  const { rerender } = render(<LessonPlayer {...props} autoPlay={autoPlay} />);
  expect(playback.play).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'In caricamento' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toBeInTheDocument();
  playback = { ...playback, loading: false, playing: true };
  rerender(<LessonPlayer {...props} autoPlay={autoPlay} />);
  expect(playback.play).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /Pausa|TTS non disponibile/ })).toBeEnabled();
});

test.each([
  false,
  true,
])('Escape clears a draft and exits note mode=%s before closing', noteMode => {
  render(<LessonPlayer {...props} autoPlay={false} />);
  if (noteMode) fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare.' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('textbox').tagName).toBe('INPUT');
  expect(screen.getByRole('dialog', { name: 'Riproduci lezione' })).toBeInTheDocument();
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalledOnce();
});

test('anchors the note when writing begins, then exits note mode after persistence', async () => {
  const { rerender } = render(<LessonPlayer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare.' } });
  playback = { ...playback, time: 10, elapsed: 10 };
  rerender(<LessonPlayer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][1]).toMatchObject({
    selectedText: 'La prima frase.',
    note: 'Da ricordare.',
    selectedTextStart: 0,
  });
  await waitFor(() => expect(screen.getByRole('textbox').tagName).toBe('INPUT'));
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('saves a note after API parsing reorders the source span properties', async () => {
  const block = LessonPlaybackBlockSchema.parse(blocks[0]);
  playback = { ...playback, blocks: [block], playing: false };
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]).toEqual([
    { projectId: 'project', lessonId: 'lesson' },
    {
      note: 'Da ricordare.',
      selectedText: 'La prima frase.',
      selectedTextStart: 0,
      contextBefore: '',
      contextAfter: 'La seconda frase.',
    },
  ]);
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('retains note text and the original sentence after a failed save and retries', async () => {
  save.mockResolvedValueOnce({ saved: false, merged: false, error: 'private backend detail' });
  const { rerender } = render(<LessonPlayer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Una nota.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('textbox')).toHaveValue('Una nota.');
  expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  expect(screen.queryByText('private backend detail')).toBeNull();
  expect(save.mock.calls[0][1].selectedText).toBe('La prima frase.');
  playback = { ...playback, time: 10, elapsed: 10 };
  rerender(<LessonPlayer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[1][1].selectedText).toBe('La prima frase.');
  await waitFor(() => expect(screen.getByRole('textbox').tagName).toBe('INPUT'));
});

test('sending a question pauses playback and prevents resuming until the answer closes', async () => {
  render(<LessonPlayer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  expect(playback.pause).toHaveBeenCalledTimes(1);
  const play = screen.getByRole('button', { name: /Pausa|TTS non disponibile/ });
  expect(play).toBeDisabled();
  fireEvent.click(play);
  expect(playback.play).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  expect(play).toBeEnabled();
});

test('mobile note mode expands the field and uses the same save path', async () => {
  render(<LessonPlayer {...props} content={{ ...content, isMobileViewport: true }} />);
  expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Invia domanda' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  const field = screen.getByRole('textbox');
  expect(field).toHaveAttribute('rows', '5');
  fireEvent.change(field, { target: { value: 'Nota dal telefono.' } });
  expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
});

afterEach(() => vi.unstubAllGlobals());

test('Space types in the floating field without pausing or recording', async () => {
  render(<LessonPlayer {...props} />);
  const input = screen.getByRole('textbox');
  await userEvent.setup().type(input, 'Una domanda');
  expect(input).toHaveValue('Una domanda');
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(playback.pause).not.toHaveBeenCalled();
});

test.each([
  'input',
  'textarea',
  'contenteditable',
])('Space is left to an external %s field', tag => {
  render(<LessonPlayer {...props} />);
  const field = document.createElement(tag === 'contenteditable' ? 'div' : tag);
  if (tag === 'contenteditable') field.setAttribute('contenteditable', 'true');
  document.body.append(field);
  const event = new KeyboardEvent('keydown', { ...space, bubbles: true, cancelable: true });
  field.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(playback.pause).not.toHaveBeenCalled();
  field.remove();
});

test('Space pauses immediately, ignores repeat and submits only on release', async () => {
  let finishTranscription!: (text: string) => void;
  vi.mocked(requestSpeechTranscription).mockReturnValue(
    new Promise(resolve => {
      finishTranscription = resolve;
    })
  );
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /Pausa|TTS non disponibile/ })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { ...space, repeat: true });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
  fireEvent.keyUp(window, space);
  expect(Recorder.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Trascrizione domanda')).toBeInTheDocument();
  await act(async () => finishTranscription('La mia domanda'));
  expect(screen.getByText('La mia domanda')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Pausa|TTS non disponibile/ })).toBeDisabled();
  expect(playback.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  expect(screen.getByRole('button', { name: /Pausa|TTS non disponibile/ })).toBeEnabled();
});

test('a spoken question with a conversation open continues that conversation', async () => {
  // Strict Mode runs effects twice: the spoken question must still be sent once.
  render(
    <StrictMode>
      <LessonPlayer {...props} autoPlay={false} />
    </StrictMode>
  );
  await recordQuestion();
  vi.mocked(requestSpeechTranscription).mockResolvedValueOnce('E poi?');
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await waitFor(() => expect(Recorder.instances.at(-1)?.state).toBe('recording'));
  fireEvent.keyUp(window, space);
  await waitFor(() => expect(sendInConversation).toHaveBeenCalledWith('E poi?'));
  expect(sendInConversation).toHaveBeenCalledOnce();
  expect(screen.getByText('Perché funziona?')).toBeInTheDocument();
});

test.each([
  'microphone',
  'transcription',
  'recording',
])('%s errors are shown in Italian and leave playback paused', async failure => {
  if (failure === 'microphone')
    getUserMedia.mockRejectedValue(new DOMException('private error', 'NotAllowedError'));
  if (failure === 'transcription')
    vi.mocked(requestSpeechTranscription).mockRejectedValue(new Error('private error'));
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  if (failure !== 'microphone') {
    await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
    if (failure === 'recording') act(() => Recorder.instances[0].onerror?.());
  }
  fireEvent.keyUp(window, space);
  const alert = await screen.findByRole('alert');
  const messages = {
    microphone: 'Permesso microfono negato. Abilitalo nelle impostazioni del browser.',
    transcription: 'Trascrizione non riuscita. Puoi riprovare senza registrare di nuovo.',
    recording: 'La registrazione si è interrotta. Riprova.',
  };
  expect(alert).toHaveTextContent(messages[failure as keyof typeof messages]);
  expect(alert).not.toHaveTextContent('private error');
  expect(playback.pause).toHaveBeenCalled();
  expect(playback.play).not.toHaveBeenCalled();
});

test('release before microphone permission resolves never starts a late recording', async () => {
  let allow!: (stream: { getTracks: () => { stop: typeof stopTrack }[] }) => void;
  getUserMedia.mockReturnValue(
    new Promise(resolve => {
      allow = resolve;
    })
  );
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  await act(async () => allow({ getTracks: () => [{ stop: stopTrack }] }));
  expect(Recorder.instances).toHaveLength(0);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('alert')).toHaveTextContent('Non ho rilevato audio. Riprova.');
  expect(playback.play).not.toHaveBeenCalled();
});

test('phone ignores Space', () => {
  render(<LessonPlayer {...props} content={{ ...content, isMobileViewport: true }} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(playback.pause).not.toHaveBeenCalled();
});

test('while an answer generates, the empty send button stops it and typing restores sending', async () => {
  const user = userEvent.setup();
  const stop = vi.fn();
  generatingResponse.stop = stop;
  render(<LessonPlayer {...props} autoPlay={false} />);
  await recordQuestion();
  fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
  expect(stop).toHaveBeenCalledOnce();
  await user.type(screen.getByRole('textbox'), 'E poi?');
  expect(screen.queryByRole('button', { name: 'Annulla' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Invia domanda' })).toBeEnabled();
});

test('a new Space request ignores the previous pending transcription', async () => {
  let finishOld!: (text: string) => void;
  vi.mocked(requestSpeechTranscription).mockReturnValueOnce(
    new Promise(resolve => {
      finishOld = resolve;
    })
  );
  render(<LessonPlayer {...props} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
  fireEvent.keyUp(window, space);
  await recordQuestion();
  await act(async () => finishOld('Domanda superata'));
  expect(screen.queryByText('Domanda superata')).toBeNull();
  expect(screen.getByText('Perché funziona?')).toBeInTheDocument();
});

test('closing during transcription prevents the answer from reopening', async () => {
  let finish!: (text: string) => void;
  vi.mocked(requestSpeechTranscription).mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
  fireEvent.keyUp(window, space);
  fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  await act(async () => finish('Domanda chiusa'));
  expect(screen.queryByText('Domanda chiusa')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chiudi risposta' })).toBeNull();
  expect(playback.play).not.toHaveBeenCalled();
});

test('unmounting stops recording and releases the microphone', async () => {
  const view = render(<LessonPlayer {...props} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
  view.unmount();
  expect(Recorder.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
});

test('recording errors stay visible when a written draft is already in the bar', async () => {
  getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Domanda da conservare' } });
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await screen.findByRole('alert');
  fireEvent.keyUp(window, space);
  expect(screen.getByRole('alert')).toHaveTextContent('Permesso microfono negato');
  expect(screen.getByRole('textbox')).toHaveValue('Domanda da conservare');
  expect(playback.play).not.toHaveBeenCalled();
});

test('entering note mode with a question draft anchors the current sentence', async () => {
  const { rerender } = render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da conservare' } });
  playback = { ...playback, time: 10, elapsed: 10 };
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].selectedText).toBe('La seconda frase.');
});

test('an empty lesson does not start preparation', () => {
  playback = { ...playback, blocks: [], playing: false };
  render(
    <LessonPlayer
      {...props}
      content={{
        ...content,
        sectionContent: '# Tema',
        sectionContentBlocks: [{ type: 'markdown', markdown: '# Tema' }],
      }}
    />
  );
  expect(playback.play).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([
  'Torna alla lezione',
  'Pausa',
  'Indietro di 5 secondi',
  'Velocita',
  'Nota',
])('Space retains native activation on %s', label => {
  render(<LessonPlayer {...props} autoPlay={false} />);
  const button = screen.getByRole('button', { name: label });
  button.focus();
  const event = new KeyboardEvent('keydown', { ...space, bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(playback.pause).not.toHaveBeenCalled();
});

test('Space retains the voice selector keyboard behavior', () => {
  render(<LessonPlayer {...props} autoPlay={false} />);
  const control = screen.getByRole('combobox', { name: 'Voce' });
  const event = new KeyboardEvent('keydown', { ...space, bubbles: true, cancelable: true });
  control.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(getUserMedia).not.toHaveBeenCalled();
});

test.each([
  'space',
  'microphone',
])('entering mobile layout cancels desktop %s recording', async mode => {
  const { rerender } = render(<LessonPlayer {...props} autoPlay={false} />);
  if (mode === 'space') fireEvent.keyDown(screen.getByRole('dialog'), space);
  else fireEvent.click(screen.getByRole('button', { name: 'Avvia dettatura' }));
  await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
  rerender(
    <LessonPlayer {...props} autoPlay={false} content={{ ...content, isMobileViewport: true }} />
  );
  expect(Recorder.instances[0].stop).toHaveBeenCalledOnce();
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
  fireEvent.keyUp(window, space);
  expect(screen.queryByRole('button', { name: 'Chiudi risposta' })).toBeNull();
});

test.each([
  'initial',
  'follow-up',
])('a timed-out %s recording waits for Space release before delivery', async mode => {
  render(<LessonPlayer {...props} autoPlay={false} />);
  if (mode === 'follow-up') await recordQuestion();
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  await waitFor(() => expect(Recorder.instances.at(-1)?.state).toBe('recording'));
  // Simulate the recorder's existing duration cap firing before keyup.
  act(() => Recorder.instances.at(-1)?.stop());
  await waitFor(() =>
    expect(requestSpeechTranscription).toHaveBeenCalledTimes(mode === 'follow-up' ? 2 : 1)
  );
  await act(async () => {});
  expect(sendInConversation).not.toHaveBeenCalled();
  if (mode === 'initial')
    expect(screen.queryByRole('button', { name: 'Chiudi risposta' })).toBeNull();
  fireEvent.keyUp(window, space);
  if (mode === 'initial') await screen.findByText('Perché funziona?');
  else await waitFor(() => expect(sendInConversation).toHaveBeenCalledOnce());
});

test('Escape in a portaled child dialog preserves the answer', async () => {
  answerPreview.open = true;
  render(<LessonPlayer {...props} autoPlay={false} />);
  await recordQuestion();
  const preview = screen.getByRole('dialog', { name: 'Anteprima' });
  fireEvent.keyDown(preview, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Chiudi risposta' })).toBeInTheDocument();
  expect(props.onClose).not.toHaveBeenCalled();
});
