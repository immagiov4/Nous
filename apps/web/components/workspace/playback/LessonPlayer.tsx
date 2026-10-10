import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { ArrowLeft, Check, RotateCcw, RotateCw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLessonPlayback } from '../../../hooks/reader/useLessonPlayback.ts';
import { useSpokenAnswer } from '../../../hooks/reader/useSpokenAnswer.ts';
import { useMobileKeyboardOffset } from '../../../hooks/useMobileKeyboardOffset.ts';
import { useSpeechInput } from '../../../hooks/useSpeechInput.ts';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { playbackSentenceSelector } from '../../../utils/reader/lessonPlayback.ts';
import { appendSpeechTranscription } from '../../shared/SpeechInputButton.tsx';
import ContextMenu from '../ContextMenu.tsx';
import ContextAnswerPanel from '../shell/ContextAnswerPanel.tsx';
import type {
  ContextAnswerState,
  WorkspaceReaderContentModel,
  WorkspaceReaderOverlaysModel,
  WorkspaceReaderTtsModel,
} from '../shell/types.ts';
import { PlaybackPlayButton, PlaybackTimeline, PlaybackVoiceSpeed } from '../UnifiedAudioPanel.tsx';
import LessonPlaybackStage from './LessonPlaybackStage.tsx';

const NOTE_SAVED_MS = 3_000;
const SKIP_SECONDS = 5;
// Height of the single-row floating composer (40px buttons, 6px padding, 1px border), so the
// playback controls and the Space hint share its axis on desktop.
const COMPOSER_BAR_HEIGHT = 'md:h-[3.375rem]';
const noAction = () => {};

/** Sends a spoken question into the open conversation, so it continues there. */
function SpokenFollowUp({
  question,
  send,
  onSent,
}: {
  question: string;
  send: (text: string) => void;
  onSent: () => void;
}) {
  useEffect(() => {
    send(question);
    onSent();
  }, [question, send, onSent]);
  return null;
}

function AnswerPanelTransition({
  children,
  shouldAnimate,
}: {
  children: ReactNode;
  shouldAnimate: boolean;
}) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      className="absolute inset-x-0 bottom-full mb-2.5 rounded-2xl"
      inert={!isPresent || undefined}
      aria-hidden={!isPresent || undefined}
      initial={{ height: shouldAnimate ? 0 : 'auto', opacity: shouldAnimate ? 0 : 1 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: shouldAnimate ? 0.2 : 0, ease: 'easeOut' }}
      style={{ overflow: 'hidden' }}
    >
      {children}
    </motion.div>
  );
}

export default function LessonPlayer({
  sectionId,
  projectId,
  content,
  overlays,
  tts,
  onClose,
  autoPlay = true,
}: {
  sectionId: string;
  projectId: string;
  content: WorkspaceReaderContentModel;
  overlays: Pick<
    WorkspaceReaderOverlaysModel,
    | 'contextAnswerSize'
    | 'libraryAssistantDataSource'
    | 'currentLessonArtifactPayloads'
    | 'onOpenLibraryReference'
    | 'onSaveConversationNote'
    | 'onUpdateConversationNote'
    | 'onSaveArtifactToLesson'
    | 'onReplaceArtifactInLesson'
  >;
  tts: Pick<
    WorkspaceReaderTtsModel,
    'currentVoice' | 'playbackRate' | 'availableVoices' | 'onVoiceChange' | 'onSpeedChange'
  >;
  onClose: () => void;
  autoPlay?: boolean;
}) {
  const sourceBlocks = useMemo(
    () =>
      content.sectionContentBlocks?.length
        ? content.sectionContentBlocks
        : [{ type: 'markdown' as const, markdown: content.sectionContent }],
    [content.sectionContentBlocks, content.sectionContent]
  );
  const initialBlocks = useMemo(() => segmentLessonPlayback(sourceBlocks), [sourceBlocks]);
  const playback = useLessonPlayback({
    projectId,
    sectionId,
    voice: tts.currentVoice,
    speed: tts.playbackRate,
    initialBlocks,
  });
  const [noteMode, setNoteMode] = useState(false);
  const [draft, setDraft] = useState('');
  const anchor = useRef<ReturnType<typeof playbackSentenceSelector>>(null);
  const [noteStatus, setNoteStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [answer, setAnswer] = useState<ContextAnswerState | null>(null);
  const [holdingSpace, setHoldingSpace] = useState(false);
  const spaceDown = useRef(false);
  const spokenQuestion = useRef<ContextAnswerState | null>(null);
  const [spokenFollowUp, setSpokenFollowUp] = useState<string | null>(null);
  const answerAudio = useSpokenAnswer(tts.currentVoice, tts.playbackRate);
  const speech = useSpeechInput({
    onTranscription: text => {
      const question = spokenQuestion.current;
      if (question?.initialQuestion) setSpokenFollowUp(text);
      else if (question) setAnswer({ ...question, initialQuestion: text });
      else changeDraft(appendSpeechTranscription(draft, text));
    },
  });
  const [composerPortal, setComposerPortal] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const { viewportHeight } = useMobileKeyboardOffset();
  const block = playback.blocks[playback.index];
  const mobile = content.isMobileViewport;
  const shouldAnimate = useShouldAnimate();
  const { play } = playback;
  useEffect(() => {
    if (autoPlay) void play();
  }, [autoPlay, play]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    backButton.current?.focus();
    return () => {
      mounted.current = false;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (noteStatus !== 'saved') return;
    const timer = setTimeout(() => setNoteStatus('idle'), NOTE_SAVED_MS);
    return () => clearTimeout(timer);
  }, [noteStatus]);

  const currentAnchor = () => {
    const original = initialBlocks[playback.index];
    if (
      !block ||
      !original ||
      block.speech !== original.speech ||
      block.spans.length !== original.spans.length ||
      block.spans.some((span, index) => {
        const sourceSpan = original.spans[index];
        return (
          span.sourceBlockIndex !== sourceSpan.sourceBlockIndex ||
          span.speech.start !== sourceSpan.speech.start ||
          span.speech.end !== sourceSpan.speech.end ||
          span.source.start !== sourceSpan.source.start ||
          span.source.end !== sourceSpan.source.end
        );
      })
    )
      return null;
    return playbackSentenceSelector(block, playback.time, playback.duration, sourceBlocks);
  };
  const changeDraft = (value: string) => {
    if (!draft && value) anchor.current = currentAnchor();
    if (!value) anchor.current = null;
    setDraft(value);
  };
  const saveNote = async () => {
    if (noteStatus === 'saving') return;
    const selector = anchor.current;
    if (!selector) {
      setNoteStatus('error');
      return;
    }
    setNoteStatus('saving');
    try {
      const result = await overlays.onSaveConversationNote(
        { projectId, lessonId: sectionId },
        {
          note: draft,
          selectedText: selector.exact,
          selectedTextStart: selector.selectionStart,
          contextBefore: selector.prefix,
          contextAfter: selector.suffix,
        }
      );
      if (!mounted.current) return;
      if (!result.saved) {
        setNoteStatus('error');
        return;
      }
      setDraft('');
      anchor.current = null;
      setNoteMode(false);
      setNoteStatus('saved');
    } catch (error) {
      console.error('Playback note save failed', error);
      if (mounted.current) setNoteStatus('error');
    }
  };
  const createQuestion = (
    question: string,
    selector = anchor.current ?? currentAnchor()
  ): ContextAnswerState => {
    return {
      id: crypto.randomUUID(),
      initialQuestion: question,
      projectId,
      lessonId: sectionId,
      lessonTitle: content.activeSectionTitle ?? undefined,
      lessonContent: content.sectionContent,
      contextScope: 'selection',
      selectedText: selector?.exact ?? block?.speech ?? '',
      selectedTextStart: selector?.selectionStart,
      contextBefore: selector?.prefix,
      contextAfter: selector?.suffix,
      documentSourceReferences: content.documentSourceReferences,
    };
  };
  const ask = (question: string) => {
    playback.pause();
    answerAudio.stop();
    spokenQuestion.current = null;
    setAnswer(createQuestion(question));
  };
  const submit = (send: (text: string) => void) => {
    if (noteMode) {
      void saveNote();
      return;
    }
    // A new question silences the voice still reading the previous answer.
    answerAudio.stop();
    send(draft.trim());
    setDraft('');
    anchor.current = null;
  };
  const listening = holdingSpace && !speech.speechInputError;
  const spaceHintHidden = Boolean(answer) || listening || noteMode || Boolean(draft);
  const questionActive = Boolean(answer) || holdingSpace;
  const pendingQuestion = Boolean(answer && !answer.initialQuestion && speech.state !== 'idle');
  const clearSpokenFollowUp = useCallback(() => setSpokenFollowUp(null), []);
  const renderComposer = ({
    send = ask,
    disabled = false,
    conversation = false,
    stopResponse,
  }: {
    send?: (text: string) => void;
    disabled?: boolean;
    conversation?: boolean;
    stopResponse?: () => void;
  } = {}) => (
    <>
      {conversation && spokenFollowUp ? (
        <SpokenFollowUp question={spokenFollowUp} send={send} onSent={clearSpokenFollowUp} />
      ) : null}
      <ContextMenu
        type="lesson"
        placement="desktop-floating"
        selectedText=""
        isDarkMode={content.isDarkMode}
        isLoading={
          noteStatus === 'saving' || holdingSpace || pendingQuestion || (!noteMode && disabled)
        }
        lessonCreationBlockReason={null}
        onAsk={send}
        onClose={noAction}
        onCreateLesson={noAction}
        onDeleteAnnotation={noAction}
        onHighlight={noAction}
        onSaveNote={noAction}
        playbackComposer={{
          isMobileViewport: mobile,
          speech: mobile
            ? undefined
            : {
                ...speech,
                startRecording: () => {
                  spokenQuestion.current = null;
                  return speech.startRecording();
                },
              },
          listening,
          value: draft,
          noteMode,
          onChange: changeDraft,
          onToggleNote: () => {
            setNoteMode(!noteMode);
            if (noteStatus === 'error') setNoteStatus('idle');
          },
          onSubmit: () => submit(send),
          stopAction: stopResponse
            ? { kind: 'response', onStop: stopResponse }
            : answerAudio.speaking
              ? { kind: 'voice', onStop: answerAudio.stop }
              : undefined,
        }}
      />
    </>
  );
  const closeAnswer = () => {
    answerAudio.stop();
    answerAudio.clearError();
    speech.reset();
    spokenQuestion.current = null;
    spaceDown.current = false;
    setHoldingSpace(false);
    setAnswer(null);
  };

  useEffect(() => {
    if (mobile) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (
        target?.closest(
          'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
        )
      )
        return;
      event.preventDefault();
      if (event.repeat || spaceDown.current) return;
      playback.pause();
      answerAudio.stop();
      answerAudio.clearError();
      speech.reset();
      spaceDown.current = true;
      setHoldingSpace(true);
      setNoteMode(false);
      // With a conversation open, the spoken question continues it instead of starting a new one.
      spokenQuestion.current = answer ?? createQuestion('', currentAnchor());
      void speech.startRecording();
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !spaceDown.current) return;
      event.preventDefault();
      spaceDown.current = false;
      setHoldingSpace(false);
      if (!speech.speechInputError) {
        setAnswer(previous => previous ?? spokenQuestion.current);
        speech.stopRecording();
      }
    };
    const blur = () => {
      if (spaceDown.current) closeAnswer();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    };
  });
  const togglePlay = () => {
    if (questionActive) return;
    if (playback.playing || playback.loading) playback.pause();
    else void playback.play();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Riproduci lezione')}
      className={`${content.isDarkMode ? 'dark' : ''} fixed inset-0 z-[80] flex flex-col bg-paper-light font-sans text-stone-800 dark:bg-paper-dark dark:text-stone-100`}
      style={{ height: viewportHeight === null ? '100dvh' : viewportHeight }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (questionActive) closeAnswer();
          else onClose();
        }
        if (event.key === 'Tab') {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]'
            )
          ).filter(element => element.getClientRects().length > 0);
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault();
            controls.at(-1)?.focus();
          } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
            event.preventDefault();
            controls[0]?.focus();
          }
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 py-3 md:gap-5 md:px-[4%] md:pt-6">
        <button
          ref={backButton}
          type="button"
          onClick={onClose}
          aria-label={t('Torna alla lezione')}
          className="rounded-full p-2 text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-zinc-800"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="truncate text-sm font-medium text-stone-500 dark:text-stone-300">
          {content.activeSectionTitle}
        </h1>
      </header>
      {block ? (
        <LessonPlaybackStage
          block={block}
          time={playback.time}
          duration={playback.duration}
          content={content}
          speed={tts.playbackRate}
          readTime={playback.readTime}
        />
      ) : (
        <p className="flex-1 p-4">{t('Questa lezione non contiene testo da ascoltare.')}</p>
      )}
      <div className="shrink-0 px-2 pb-2 md:relative md:flex md:items-end md:justify-between md:gap-4 md:px-[4%] md:pb-6">
        <div
          className={`min-w-0 pb-2 md:relative md:flex md:items-center md:pb-0 ${COMPOSER_BAR_HEIGHT}`}
        >
          {/* On desktop, status lines sit above the controls so the bottom row keeps one axis. */}
          <div className="md:absolute md:bottom-full md:left-0 md:w-max md:max-w-[45vw]">
            {playback.loading ? (
              <output className="mb-2 block text-xs text-stone-500 dark:text-stone-300">
                {t('Preparo voce e visualizzazione…')}
              </output>
            ) : null}
            {playback.failed ? (
              <p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-300">
                {t('Impossibile preparare l’ascolto della lezione. Riprova.')}{' '}
                <button
                  type="button"
                  onClick={() => {
                    if (!questionActive) void playback.play();
                  }}
                  disabled={questionActive}
                  className="underline"
                >
                  {t('Riprova')}
                </button>
              </p>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:items-center md:gap-3">
            <div className="flex items-center gap-2 md:gap-3">
              <button
                type="button"
                onClick={() => playback.seek(playback.elapsed - SKIP_SECONDS)}
                disabled={playback.loading || !playback.duration}
                aria-label={t('Indietro di 5 secondi')}
                className="relative rounded-md p-1 text-gray-600 transition-colors hover:bg-gray-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <RotateCcw className="h-6 w-6" />
                <span className="absolute inset-0 grid place-items-center pt-px text-[8px] font-bold">
                  5
                </span>
              </button>
              <PlaybackPlayButton
                stationary
                onClick={togglePlay}
                disabled={questionActive || !block}
                loading={playback.loading}
                playing={playback.playing}
              />
              <button
                type="button"
                onClick={() => playback.seek(playback.elapsed + SKIP_SECONDS)}
                disabled={playback.loading || !playback.duration}
                aria-label={t('Avanti di 5 secondi')}
                className="relative rounded-md p-1 text-gray-600 transition-colors hover:bg-gray-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <RotateCw className="h-6 w-6" />
                <span className="absolute inset-0 grid place-items-center pt-px text-[8px] font-bold">
                  5
                </span>
              </button>
              <div className="ml-auto md:ml-0">
                <PlaybackVoiceSpeed tts={tts} pill />
              </div>
            </div>
            <div
              className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none md:w-52 ${mobile && playback.playing ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}
              inert={(mobile && playback.playing) || undefined}
            >
              <div className="overflow-hidden">
                <PlaybackTimeline
                  time={playback.elapsed}
                  duration={playback.total}
                  estimated={playback.estimated}
                  onSeek={playback.seek}
                />
              </div>
            </div>
          </div>
        </div>
        {/* Desktop only: push-to-talk has no equivalent on touch screens. */}
        <p
          aria-hidden={spaceHintHidden}
          className={`pointer-events-none hidden min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap ${COMPOSER_BAR_HEIGHT} text-xs text-stone-500 transition-opacity duration-200 ease-out motion-reduce:transition-none md:flex dark:text-stone-400 ${spaceHintHidden ? 'opacity-0' : 'opacity-100'}`}
        >
          {t('Tieni premuto')}
          <kbd className="font-sans">{t('Spazio')}</kbd>
          {t('per fare una domanda a voce')}
        </p>
        <div className="relative flex min-w-0 flex-col gap-2.5 md:w-[30rem] md:max-w-[45vw]">
          <AnimatePresence>
            {answer ? (
              <AnswerPanelTransition key={answer.id} shouldAnimate={shouldAnimate}>
                <ContextAnswerPanel
                  contextAnswer={answer}
                  pendingQuestion={pendingQuestion}
                  onAnswerProgress={text => {
                    if (spokenQuestion.current?.id === answer.id) answerAudio.follow(text, false);
                  }}
                  onAnswerComplete={text => {
                    if (spokenQuestion.current?.id !== answer.id) return;
                    spokenQuestion.current = null;
                    answerAudio.follow(text, true);
                  }}
                  contextAnswerPanelRef={panelRef}
                  contextAnswerSize={overlays.contextAnswerSize}
                  handleContextAnswerResizeStart={noAction}
                  isDarkMode={content.isDarkMode}
                  isMobileViewport={mobile}
                  docked
                  composerPortal={composerPortal}
                  renderComposer={(send, disabled, stopResponse) =>
                    renderComposer({ send, disabled, conversation: true, stopResponse })
                  }
                  libraryAssistantDataSource={overlays.libraryAssistantDataSource}
                  currentLessonArtifactPayloads={overlays.currentLessonArtifactPayloads}
                  onClose={closeAnswer}
                  onOpenLibraryReference={reference => {
                    onClose();
                    overlays.onOpenLibraryReference(reference);
                  }}
                  onSaveConversationNote={overlays.onSaveConversationNote}
                  onUpdateConversationNote={overlays.onUpdateConversationNote}
                  onSaveArtifactToLesson={overlays.onSaveArtifactToLesson}
                  onReplaceArtifactInLesson={overlays.onReplaceArtifactInLesson}
                />
              </AnswerPanelTransition>
            ) : null}
          </AnimatePresence>
          {answerAudio.error ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {answerAudio.error}
            </p>
          ) : null}
          {noteStatus === 'saved' ? (
            <output className="inline-flex items-center gap-2 self-end rounded-full bg-white px-3 py-2 text-xs font-semibold text-amber-800 shadow-sm dark:bg-zinc-800 dark:text-amber-200">
              <Check className="h-3.5 w-3.5" />
              {t('Nota salvata')}
            </output>
          ) : null}
          {noteStatus === 'error' ? (
            <p
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {t('Non sono riuscito a salvare la nota.')}{' '}
              <button
                type="button"
                onClick={() => void saveNote()}
                className="font-semibold underline"
              >
                {t('Riprova')}
              </button>
            </p>
          ) : null}
          <div ref={setComposerPortal} />
          {!answer ? renderComposer() : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
