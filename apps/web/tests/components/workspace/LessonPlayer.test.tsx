// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import LessonPlayer from '../../../components/workspace/playback/LessonPlayer.tsx';
import type {
  WorkspaceReaderContentModel,
  WorkspaceReaderOverlaysModel,
} from '../../../components/workspace/shell/types.ts';
import { useLessonPlayback } from '../../../hooks/reader/useLessonPlayback.ts';
import { setAccountLocale } from '../../../i18n/uiMessages.ts';
import { requestSpeechTranscription } from '../../../services/openrouter/sttClient.ts';
import { generateSpeech } from '../../../services/openrouter/tts.ts';

const completedAnswer = vi.hoisted(() => ({ text: 'La risposta completa alla domanda.' }));

vi.mock('../../../hooks/reader/useLessonPlayback.ts', () => ({ useLessonPlayback: vi.fn() }));
vi.mock('../../../components/workspace/playback/LessonPlaybackStage.tsx', () => ({
  default: () => <div />,
}));
vi.mock('../../../services/openrouter/sttClient.ts', () => ({
  requestSpeechTranscription: vi.fn(),
}));
vi.mock('../../../services/openrouter/tts.ts', () => ({ generateSpeech: vi.fn() }));
vi.mock('../../../components/workspace/shell/ContextAnswerPanel.tsx', () => ({
  default: ({
    onClose,
    contextAnswer,
    pendingQuestion,
    onAnswerComplete,
    renderComposer,
  }: ComponentProps<
    typeof import('../../../components/workspace/shell/ContextAnswerPanel.tsx').default
  >) => (
    <div>
      <p>{pendingQuestion ? 'Trascrizione domanda' : contextAnswer.initialQuestion}</p>
      <button type="button" onClick={onClose}>
        Chiudi risposta
      </button>
      <button type="button" onClick={() => onAnswerComplete?.(completedAnswer.text)}>
        Completa risposta
      </button>
      {renderComposer?.(vi.fn(), false)}
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
class AnswerAudio {
  static instances: AnswerAudio[] = [];
  playbackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor() {
    AnswerAudio.instances.push(this);
  }
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
  completedAnswer.text = 'La risposta completa alla domanda.';
  Recorder.instances = [];
  AnswerAudio.instances = [];
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  stopTrack.mockReset();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('Audio', AnswerAudio);
  vi.mocked(requestSpeechTranscription).mockReset().mockResolvedValue('Perché funziona?');
  vi.mocked(generateSpeech)
    .mockReset()
    .mockResolvedValue({ audioBuffer: new ArrayBuffer(4), contentType: 'audio/wav' });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, writable: true, value: vi.fn(() => 'blob:answer') },
    revokeObjectURL: { configurable: true, writable: true, value: vi.fn() },
  });
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
  };
  vi.mocked(useLessonPlayback).mockImplementation(() => playback);
  save.mockResolvedValue({ saved: true, merged: false, annotationId: 'annotation' });
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
  expect(playback.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  expect(play).toBeEnabled();
});

test('mobile note mode expands the field and uses the same save path', async () => {
  render(<LessonPlayer {...props} content={{ ...content, isMobileViewport: true }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }));
  const field = screen.getByRole('textbox');
  expect(field).toHaveAttribute('rows', '5');
  fireEvent.change(field, { target: { value: 'Nota dal telefono.' } });
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
  render(<LessonPlayer {...props} />);
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

test.each([
  'close',
  'space',
])('speaks the answer in the configured voice and stops on %s', async action => {
  render(<LessonPlayer {...props} tts={{ ...tts, playbackRate: 1.5 }} />);
  await recordQuestion();
  fireEvent.click(screen.getByRole('button', { name: 'Completa risposta' }));
  await waitFor(() => expect(AnswerAudio.instances[0]?.play).toHaveBeenCalledTimes(1));
  expect(generateSpeech).toHaveBeenCalledWith('La risposta completa alla domanda.', 'Kore');
  expect(AnswerAudio.instances[0].playbackRate).toBe(1.5);
  if (action === 'close') fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  else fireEvent.keyDown(window, space);
  expect(AnswerAudio.instances[0].pause).toHaveBeenCalled();
  expect(playback.play).not.toHaveBeenCalled();
});

test('closing while speech is being generated prevents late audio playback', async () => {
  let finishSpeech!: (result: Awaited<ReturnType<typeof generateSpeech>>) => void;
  vi.mocked(generateSpeech).mockReturnValue(
    new Promise(resolve => {
      finishSpeech = resolve;
    })
  );
  render(<LessonPlayer {...props} />);
  await recordQuestion();
  fireEvent.click(screen.getByRole('button', { name: 'Completa risposta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chiudi risposta' }));
  await act(async () =>
    finishSpeech({ audioBuffer: new ArrayBuffer(4), contentType: 'audio/wav' })
  );
  expect(AnswerAudio.instances).toHaveLength(0);
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
  render(<LessonPlayer {...props} />);
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
  render(<LessonPlayer {...props} />);
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

test('reads every part of a long answer through to the end', async () => {
  completedAnswer.text = 'Questa frase fa parte della risposta completa. '.repeat(40).trim();
  render(<LessonPlayer {...props} />);
  await recordQuestion();
  fireEvent.click(screen.getByRole('button', { name: 'Completa risposta' }));
  // End each audio segment as a real audio element does; the next must start on its own.
  for (let index = 0; index < 10; index++) {
    await waitFor(() => expect(AnswerAudio.instances[index]?.play).toHaveBeenCalledTimes(1));
    const spoken = vi
      .mocked(generateSpeech)
      .mock.calls.map(([text]) => text)
      .join(' ');
    await act(async () => AnswerAudio.instances[index].onended?.());
    if (spoken === completedAnswer.text) break;
  }
  expect(
    vi
      .mocked(generateSpeech)
      .mock.calls.map(([text]) => text)
      .join(' ')
  ).toBe(completedAnswer.text);
  expect(AnswerAudio.instances.length).toBeGreaterThan(1);
  expect(playback.play).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Pausa' })).toBeDisabled();
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
  render(<LessonPlayer {...props} />);
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
  render(<LessonPlayer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Domanda da conservare' } });
  fireEvent.keyDown(window, space);
  await screen.findByRole('alert');
  fireEvent.keyUp(window, space);
  expect(screen.getByRole('alert')).toHaveTextContent('Permesso microfono negato');
  expect(screen.getByRole('textbox')).toHaveValue('Domanda da conservare');
  expect(playback.play).not.toHaveBeenCalled();
});
