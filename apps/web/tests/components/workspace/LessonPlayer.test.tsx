// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, StrictMode } from 'react';
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

vi.mock('../../../hooks/reader/useLessonPlayback.ts', () => ({ useLessonPlayback: vi.fn() }));
vi.mock('../../../components/workspace/playback/LessonPlaybackStage.tsx', () => ({
  default: () => <div />,
}));
vi.mock('../../../services/openrouter/sttClient.ts', () => ({
  requestSpeechTranscription: vi.fn(),
}));
vi.mock('../../../components/workspace/shell/ContextAnswerPanel.tsx', () => ({
  default: ({
    onClose,
    contextAnswer,
    pendingQuestion,
    renderComposer,
  }: ComponentProps<
    typeof import('../../../components/workspace/shell/ContextAnswerPanel.tsx').default
  >) => (
    <div>
      <p>{pendingQuestion ? 'Trascrizione domanda' : contextAnswer.initialQuestion}</p>
      <button type="button" onClick={onClose}>
        Chiudi risposta
      </button>
      {renderComposer?.(sendInConversation, false, generatingResponse.stop ?? undefined)}
    </div>
  ),
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
  fireEvent.keyDown(window, space);
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
  expect(screen.getByRole('button', { name: 'Pausa' })).toBeEnabled();
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
  render(<LessonPlayer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Una nota.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('textbox')).toHaveValue('Una nota.');
  expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  expect(screen.queryByText('private backend detail')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  await waitFor(() => expect(screen.getByRole('textbox').tagName).toBe('INPUT'));
});

test('sending a question pauses playback and prevents resuming until the answer closes', async () => {
  render(<LessonPlayer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  expect(playback.pause).toHaveBeenCalledTimes(1);
  const play = screen.getByRole('button', { name: 'Pausa' });
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
  fireEvent.keyDown(window, space);
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Pausa' })).toBeDisabled();
  fireEvent.keyDown(window, { ...space, repeat: true });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(Recorder.instances[0]?.state).toBe('recording'));
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
  fireEvent.keyUp(window, space);
  expect(Recorder.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Trascrizione domanda')).toBeInTheDocument();
  await act(async () => finishTranscription('La mia domanda'));
  expect(screen.getByText('La mia domanda')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pausa' })).toBeDisabled();
  expect(playback.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  expect(screen.getByRole('button', { name: 'Pausa' })).toBeEnabled();
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
  fireEvent.keyDown(window, space);
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
  fireEvent.keyDown(window, space);
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
  fireEvent.keyDown(window, space);
  fireEvent.keyUp(window, space);
  await act(async () => allow({ getTracks: () => [{ stop: stopTrack }] }));
  expect(Recorder.instances).toHaveLength(0);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('alert')).toHaveTextContent('Non ho rilevato audio. Riprova.');
  expect(playback.play).not.toHaveBeenCalled();
});

test('phone ignores Space', () => {
  render(<LessonPlayer {...props} content={{ ...content, isMobileViewport: true }} />);
  fireEvent.keyDown(window, space);
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
  fireEvent.keyDown(window, space);
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
  fireEvent.keyDown(window, space);
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
  fireEvent.keyDown(window, space);
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
  fireEvent.keyDown(window, space);
  await screen.findByRole('alert');
  fireEvent.keyUp(window, space);
  expect(screen.getByRole('alert')).toHaveTextContent('Permesso microfono negato');
  expect(screen.getByRole('textbox')).toHaveValue('Domanda da conservare');
  expect(playback.play).not.toHaveBeenCalled();
});
