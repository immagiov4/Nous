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
const composerState = vi.hoisted(() => ({ disabled: false }));
const answerPreview = vi.hoisted(() => ({ open: false }));
const answerPanelProps = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/reader/useLessonPlayback.ts', () => ({ useLessonPlayback: vi.fn() }));
vi.mock('../../../components/workspace/playback/LessonPlaybackStage.tsx', () => ({
  default: () => <div data-testid="playback-stage" />,
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
        {renderComposer?.(
          sendInConversation,
          composerState.disabled,
          generatingResponse.stop ?? undefined,
          <button type="button" aria-label="Conversation tools slot">
            Tools
          </button>
        )}
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
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), space));
  expect(Recorder.instances.at(-1)?.state).toBe('recording');
  await act(async () => fireEvent.keyUp(window, space));
  expect(screen.getByText('Perché funziona?')).toBeInTheDocument();
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
  composerState.disabled = false;
  answerPreview.open = false;
  answerPanelProps.mockClear();
  Recorder.instances = [];
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  stopTrack.mockReset();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.mocked(requestSpeechTranscription).mockReset().mockResolvedValue('Perché funziona?');
  playback = {
    lessonKey: 'old',
    blocks,
    recording: undefined,
    seekRevision: 0,
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
    readTime: vi.fn(() => playback.time),
    readPosition: vi.fn(() => ({
      index: playback.index,
      time: playback.readTime(),
      duration: playback.duration,
    })),
  };
  vi.mocked(useLessonPlayback).mockImplementation(() => playback);
  save.mockResolvedValue({ saved: true, merged: false, annotationId: 'annotation' });
});

test('playback failure shows one retry action without duplicated retry text', () => {
  playback = { ...playback, failed: true, playing: false };
  render(<LessonPlayer {...props} autoPlay={false} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Impossibile preparare l’ascolto della lezione. Riprova'
  );
  expect(screen.getByRole('alert').textContent?.match(/Riprova/g)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
  expect(playback.play).toHaveBeenCalledTimes(1);
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

test('keeps keyboard focus in the open player and lets the speed menu consume Escape', () => {
  render(<LessonPlayer {...props} autoPlay={false} />);
  const dialog = screen.getByRole('dialog', { name: 'Riproduci lezione' });
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  expect(dialog).toHaveAttribute('open');
  const visibleControls = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
    length: 1,
  } as DOMRectList);
  try {
    const first = screen.getByRole('button', { name: 'Torna alla lezione' });
    const controls = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]'
    );
    const last = controls[controls.length - 1];
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Velocita' }));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Velocita' }), { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Velocita' })).toHaveFocus();
  } finally {
    visibleControls.mockRestore();
  }
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
  expect(field).toHaveFocus();
  fireEvent.change(field, { target: { value: 'Nota dal telefono.' } });
  expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
  let allowMicrophone!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>(resolve => {
    allowMicrophone = resolve;
  });
  getUserMedia.mockReturnValueOnce(permission);
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
  await act(async () => {
    allowMicrophone({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await permission;
    expect(Recorder.instances[0]?.state).toBe('recording');
    expect(requestSpeechTranscription).not.toHaveBeenCalled();
    // Release after capture starts but before React commits its recording state.
    fireEvent.keyUp(window, space);
  });
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
  let finishTranscription!: (text: string) => void;
  const transcription = new Promise<string>(resolve => {
    finishTranscription = resolve;
  });
  vi.mocked(requestSpeechTranscription).mockReturnValueOnce(transcription);
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), space));
  expect(Recorder.instances.at(-1)?.state).toBe('recording');
  fireEvent.keyUp(window, space);
  await act(async () => {
    finishTranscription('E poi?');
    await transcription;
  });
  expect(sendInConversation).toHaveBeenCalledWith('E poi?');
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
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), space));
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
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chiudi risposta' })).toBeNull();
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
  expect(sendInConversation).not.toHaveBeenCalled();
  expect(playback.play).not.toHaveBeenCalled();
});

test('phone ignores Space', () => {
  render(<LessonPlayer {...props} content={{ ...content, isMobileViewport: true }} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(playback.pause).not.toHaveBeenCalled();
});

test.each([false, true])('generation preserves the draft and Stop on mobile=%s', mobile => {
  const stop = vi.fn();
  generatingResponse.stop = stop;
  render(
    <LessonPlayer {...props} autoPlay={false} content={{ ...content, isMobileViewport: mobile }} />
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  const input = screen.getByRole('textbox');
  expect(input.closest('form')).toContainElement(
    screen.getByRole('button', { name: 'Conversation tools slot' })
  );
  expect(input).toBeEnabled();
  if (mobile) expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeEnabled();
  fireEvent.change(input, { target: { value: 'E poi?' } });
  expect(screen.queryByRole('button', { name: 'Invia domanda' })).toBeNull();
  const form = input.closest('form');
  if (!form) throw new Error('Expected the question composer form');
  fireEvent.submit(form);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(sendInConversation).not.toHaveBeenCalled();
  expect(input).toHaveValue('E poi?');
  fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
  expect(stop).toHaveBeenCalledOnce();
  expect(input).toHaveValue('E poi?');
});

test('mobile dictation updates the draft without sending while an answer generates', async () => {
  generatingResponse.stop = vi.fn();
  render(
    <LessonPlayer {...props} autoPlay={false} content={{ ...content, isMobileViewport: true }} />
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Avvia dettatura' })));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ferma e trascrivi' })));
  expect(screen.getByRole('textbox')).toHaveValue('Perché funziona?');
  expect(sendInConversation).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Invia domanda' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Annulla' })).toBeEnabled();
});

test.each([false, true])('notes can be saved during generation on mobile=%s', async mobile => {
  const stop = vi.fn();
  generatingResponse.stop = stop;
  render(
    <LessonPlayer {...props} autoPlay={false} content={{ ...content, isMobileViewport: mobile }} />
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  expect(screen.getByRole('button', { name: 'Nota' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare.' } });
  expect(screen.getByRole('button', { name: 'Annulla' })).toBeEnabled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salva nota' })));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][1]).toMatchObject({ note: 'Da ricordare.' });
  expect(sendInConversation).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Annulla' })).toBeEnabled();
});

test('release cancels a pending permission denial silently', async () => {
  let denyPermission!: (error: DOMException) => void;
  const permission = new Promise<MediaStream>((_resolve, reject) => {
    denyPermission = reject;
  });
  getUserMedia.mockReturnValueOnce(permission);
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  await act(async () => {
    denyPermission(new DOMException('denied', 'NotAllowedError'));
    await permission.catch(() => {});
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chiudi risposta' })).toBeNull();
  expect(Recorder.instances).toHaveLength(0);
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
  expect(sendInConversation).not.toHaveBeenCalled();
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

test.each([
  'note',
  'spoken question',
])('%s anchors the live audio position before the next timeupdate', async action => {
  playback.readTime = vi.fn(() => 10);
  render(<LessonPlayer {...props} autoPlay={false} />);
  if (action === 'note') {
    fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salva nota' })));
    expect(save.mock.calls[0][1].selectedText).toBe('La seconda frase.');
  } else {
    await recordQuestion();
    expect(answerPanelProps.mock.lastCall?.[0].contextAnswer.selectedText).toBe(
      'La seconda frase.'
    );
  }
});

test('a note during preparation uses the target position instead of the previous audio', async () => {
  playback = {
    ...playback,
    loading: true,
    playing: false,
    time: 0,
    readTime: vi.fn(() => 10),
    readPosition: vi.fn(() => ({ index: 0, time: 0, duration: 12 })),
  };
  render(<LessonPlayer {...props} autoPlay={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salva nota' })));
  expect(save.mock.calls[0][1].selectedText).toBe('La prima frase.');
  expect(playback.readTime).not.toHaveBeenCalled();
});

test.each([
  false,
  true,
])('manual dictation pauses before microphone access on mobile=%s', async mobile => {
  render(
    <LessonPlayer {...props} autoPlay={false} content={{ ...content, isMobileViewport: mobile }} />
  );
  getUserMedia.mockImplementationOnce(async () => {
    expect(playback.pause).toHaveBeenCalledOnce();
    return { getTracks: () => [{ stop: stopTrack }] };
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Avvia dettatura' })));
  expect(Recorder.instances[0].state).toBe('recording');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ferma e trascrivi' })));
  expect(screen.getByRole('textbox')).toHaveValue('Perché funziona?');
  expect(playback.pause).toHaveBeenCalledOnce();
});

test.each([
  'note',
  'typed question',
  'spoken question',
])('%s anchors a nonzero preparation target', async action => {
  playback = {
    ...playback,
    loading: true,
    duration: 0,
    readTime: vi.fn(() => 0),
    readPosition: vi.fn(() => ({ index: 0, time: 0.8, duration: 1 })),
  };
  render(<LessonPlayer {...props} autoPlay={false} />);
  if (action === 'spoken question') await recordQuestion();
  else {
    if (action === 'note') fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Da ricordare' } });
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: action === 'note' ? 'Salva nota' : 'Invia domanda' })
      )
    );
  }
  const selection =
    action === 'note' ? save.mock.calls[0][1] : answerPanelProps.mock.lastCall?.[0].contextAnswer;
  expect(selection).toMatchObject({ selectedText: 'La seconda frase.', selectedTextStart: 16 });
});

test.each([
  'typed',
  'spoken',
])('a %s question without playback blocks uses lesson context', async mode => {
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
  if (mode === 'spoken') await recordQuestion();
  else {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  }
  expect(answerPanelProps.mock.lastCall?.[0].contextAnswer).toMatchObject({
    contextScope: 'lesson',
    selectedText: '# Tema',
    lessonContent: '# Tema',
  });
});

test.each([
  false,
  true,
])('a lesson without text keeps the composer unavailable on mobile=%s', mobile => {
  playback = { ...playback, blocks: [], playing: false };
  render(
    <LessonPlayer
      {...props}
      content={{
        ...content,
        sectionContent: '',
        sectionContentBlocks: [{ type: 'generated-visual', slotId: 'slot', visualId: 'figure' }],
        isMobileViewport: mobile,
      }}
    />
  );
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Perché?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invia domanda' }));
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(answerPanelProps).not.toHaveBeenCalled();
});

test('a pending note decision blocks Space capture', async () => {
  const { rerender } = render(<LessonPlayer {...props} autoPlay={false} />);
  await recordQuestion();
  composerState.disabled = true;
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  getUserMedia.mockClear();
  fireEvent.keyDown(screen.getByRole('dialog'), space);
  fireEvent.keyUp(window, space);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(sendInConversation).not.toHaveBeenCalled();
});

test.each([
  'note decision',
  'generation',
])('a transcribed follow-up waits for %s to finish and is sent once', async reason => {
  const { rerender } = render(<LessonPlayer {...props} autoPlay={false} />);
  await recordQuestion();
  let finish!: (text: string) => void;
  vi.mocked(requestSpeechTranscription).mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), space));
  fireEvent.keyUp(window, space);
  if (reason === 'note decision') composerState.disabled = true;
  else generatingResponse.stop = vi.fn();
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  await act(async () => finish('E poi?'));
  expect(sendInConversation).not.toHaveBeenCalled();
  composerState.disabled = false;
  generatingResponse.stop = null;
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  expect(sendInConversation).toHaveBeenCalledExactlyOnceWith('E poi?');
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  expect(sendInConversation).toHaveBeenCalledOnce();
});

test.each([
  'permission',
  'recording',
  'transcription',
])('blur cancels follow-up %s and preserves the established answer', async phase => {
  render(<LessonPlayer {...props} autoPlay={false} />);
  await recordQuestion();
  let grant!: (stream: MediaStream) => void;
  let finish!: (text: string) => void;
  if (phase === 'permission') {
    getUserMedia.mockReturnValueOnce(
      new Promise(resolve => {
        grant = resolve;
      })
    );
  } else if (phase === 'transcription') {
    vi.mocked(requestSpeechTranscription).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
  }
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), space));
  if (phase === 'transcription') act(() => Recorder.instances.at(-1)?.stop());
  fireEvent.blur(window);
  if (phase === 'permission') {
    await act(async () =>
      grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
    );
  } else if (phase === 'transcription') await act(async () => finish('Da scartare'));
  fireEvent.keyUp(window, space);
  expect(screen.getByText('Perché funziona?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Chiudi risposta' })).toBeInTheDocument();
  expect(sendInConversation).not.toHaveBeenCalled();
  expect(stopTrack).toHaveBeenCalledTimes(2);
  expect(playback.play).not.toHaveBeenCalled();
});

test.each([
  'microphone',
  'recording',
])('releasing Space after the %s error disappears does not open an empty answer', async failure => {
  vi.useFakeTimers();
  if (failure === 'microphone')
    getUserMedia.mockRejectedValueOnce(new DOMException('Busy', 'NotReadableError'));
  render(<LessonPlayer {...props} autoPlay={false} />);
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), space));
  if (failure === 'recording') act(() => Recorder.instances[0].onerror?.());
  expect(screen.getByRole('alert')).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.keyUp(window, space);
  expect(screen.queryByRole('button', { name: 'Chiudi risposta' })).toBeNull();
  expect(screen.getByRole('button', { name: /Pausa|TTS non disponibile/ })).toBeEnabled();
  expect(requestSpeechTranscription).not.toHaveBeenCalled();
  expect(sendInConversation).not.toHaveBeenCalled();
  expect(playback.play).not.toHaveBeenCalled();
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

test('preserves the stage for preparation updates and remounts it for a new lesson version', () => {
  const { rerender } = render(<LessonPlayer {...props} autoPlay={false} />);
  const stage = screen.getByTestId('playback-stage');
  stage.scrollTop = 200;
  playback = { ...playback, blocks: structuredClone(blocks) };
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  expect(screen.getByTestId('playback-stage')).toBe(stage);
  expect(stage.scrollTop).toBe(200);
  playback = { ...playback, lessonKey: 'new', time: 0 };
  rerender(<LessonPlayer {...props} autoPlay={false} />);
  expect(screen.getByTestId('playback-stage')).not.toBe(stage);
  expect(screen.getByTestId('playback-stage').scrollTop).toBe(0);
});
