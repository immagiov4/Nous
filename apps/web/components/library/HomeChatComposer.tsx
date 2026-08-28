import { ArrowUp, Check, Globe, Loader2, Paperclip, Plus, Sparkles, Square, X } from 'lucide-react';
import type { RefObject, SyntheticEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { HomeChatMode, LibraryContextRef, LibraryTree, Message } from '../../types.ts';
import SpeechInputButton, { appendSpeechTranscription } from '../shared/SpeechInputButton.tsx';
import HomeChatLibraryContextPicker, {
  getAttachedContextProjectIds,
} from './HomeChatLibraryContextPicker.tsx';

export type HomeChatSurfaceState = null | 'attachment-menu' | 'tool-menu';
export type StopGenerationHandler = () => boolean | undefined | Promise<boolean | undefined>;
export type LibraryMessageSendHandler = ((message: string) => void | Promise<void>) & {
  readonly stop?: StopGenerationHandler;
};
type MenuAlign = 'start' | 'end';
type MenuVerticalPlacement = 'above' | 'below';

const FLOATING_MENU_GAP_PX = 12;
const FLOATING_MENU_VIEWPORT_MARGIN_PX = 16;

interface HomeChatComposerProps {
  readonly activeSurface: HomeChatSurfaceState;
  readonly assessmentComplete: boolean;
  readonly assessmentMessages: Message[];
  readonly compactSurface?: boolean;
  readonly draftTemplate?: {
    id: string;
    mode?: HomeChatMode;
    selection?: { end: number; start: number };
    value: string;
  };
  readonly draftValueOverride?: string;
  readonly homeChatMode: HomeChatMode;
  readonly inputPlaceholder?: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly isLibraryLoading: boolean;
  readonly isLoading: boolean;
  readonly isMobileViewport: boolean;
  readonly libraryAttachedContextRefs: LibraryContextRef[];
  readonly libraryGenerateArtifacts: boolean;
  readonly libraryTree: LibraryTree;
  readonly libraryWebSearch: boolean;
  readonly onClearPendingFile: () => void;
  readonly onActiveSurfaceChange: (surface: HomeChatSurfaceState) => void;
  readonly onLibraryGenerateArtifactsChange: (value: boolean) => void;
  readonly onLibraryMessageSend: LibraryMessageSendHandler;
  readonly onLibraryWebSearchChange: (value: boolean) => void;
  readonly onSendAssessmentMessage: (message: string) => Promise<void>;
  readonly onStopGeneration?: StopGenerationHandler;
  readonly onToggleLibraryContextRef: (reference: LibraryContextRef) => void;
  readonly onUploadSourceClick: () => void;
  readonly pendingFileName: string | null;
  readonly pendingFileNames?: string[];
  readonly viewportHeight: number | null;
}

interface ToolOptionProps {
  readonly className?: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly icon: typeof Globe;
  readonly label: string;
  readonly mobile: boolean;
  readonly onChange: () => void;
}

const getMenuVerticalPlacement = (
  anchorRect: DOMRect,
  menuHeight: number,
  viewportHeight: number
): MenuVerticalPlacement => {
  const spaceAbove = anchorRect.top - FLOATING_MENU_GAP_PX - FLOATING_MENU_VIEWPORT_MARGIN_PX;
  const spaceBelow =
    viewportHeight - anchorRect.bottom - FLOATING_MENU_GAP_PX - FLOATING_MENU_VIEWPORT_MARGIN_PX;
  if (spaceAbove >= menuHeight) return 'above';
  if (spaceBelow >= menuHeight) return 'below';
  return spaceBelow > spaceAbove ? 'below' : 'above';
};

const getDisplayedPendingFileNames = (
  pendingFileName: string | null,
  pendingFileNames?: string[]
) => {
  if (pendingFileNames?.length) return pendingFileNames;
  return pendingFileName ? [pendingFileName] : [];
};

const getComposerPlaceholder = (
  homeChatMode: HomeChatMode,
  assessmentComplete: boolean,
  inputPlaceholder?: string
) => {
  if (inputPlaceholder) return inputPlaceholder;
  if (homeChatMode === 'library-query') {
    return t('Chiedi progressi, riassunti, note o confronti tra corsi...');
  }
  if (assessmentComplete) return t('Aggiungi dettagli o requisiti...');
  return t(
    "Descrivi l'obiettivo del corso o allega un file: cosa prepari, livello attuale, scadenza..."
  );
};

const ToolOption = ({
  className,
  description,
  enabled,
  icon,
  label,
  mobile,
  onChange,
}: ToolOptionProps) => {
  const Icon = icon;
  const layoutClassName = mobile
    ? 'flex w-full items-start gap-3 rounded-[1.2rem] border border-gray-200 px-4 py-4 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800'
    : 'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/80';
  const labelColor = mobile ? 'text-gray-900' : 'text-gray-800';
  return (
    <button
      type="button"
      onClick={onChange}
      className={`${className || ''} ${layoutClassName}`}
      {...(mobile ? {} : { role: 'menuitemcheckbox' as const, 'aria-checked': enabled })}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
          enabled
            ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
            : 'border-gray-300 text-transparent dark:border-zinc-500'
        }`}
      >
        <Check className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span
          className={`flex items-center gap-2 text-sm font-medium ${labelColor} dark:text-zinc-100`}
        >
          <Icon className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
          {label}
        </span>
        <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
          {description}
        </span>
      </span>
    </button>
  );
};

interface PendingFilesNoticeProps {
  readonly assessmentMessages: Message[];
  readonly displayedPendingFileNames: string[];
  readonly displayedPendingFiles: Array<{ key: string; name: string }>;
  readonly onClearPendingFile: () => void;
}

const PendingFilesNotice = ({
  assessmentMessages,
  displayedPendingFileNames,
  displayedPendingFiles,
  onClearPendingFile,
}: PendingFilesNoticeProps) => {
  if (displayedPendingFileNames.length === 0) return null;
  const summary =
    displayedPendingFileNames.length === 1
      ? displayedPendingFileNames[0]
      : t('{count} fonti selezionate', { count: displayedPendingFileNames.length });
  return (
    <div className="mb-3 flex items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
      <div className="flex min-w-0 items-start gap-2">
        <Paperclip className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <span className="font-medium">{summary}</span>
          {displayedPendingFileNames.length > 1 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-gray-500 dark:text-zinc-400">
              {displayedPendingFiles.map(file => (
                <li key={file.key} className="truncate">
                  {file.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {assessmentMessages.length === 0 ? (
        <button
          type="button"
          onClick={onClearPendingFile}
          className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-stone-600 dark:hover:text-zinc-100"
          title={t('Rimuovi allegato')}
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
};

const AttachmentButton = ({
  activeSurface,
  assessmentMessages,
  attachedContextCount,
  buttonRef,
  homeChatMode,
  onActiveSurfaceChange,
  onUploadSourceClick,
}: {
  readonly activeSurface: HomeChatSurfaceState;
  readonly assessmentMessages: Message[];
  readonly attachedContextCount: number;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly homeChatMode: HomeChatMode;
  readonly onActiveSurfaceChange: (surface: HomeChatSurfaceState) => void;
  readonly onUploadSourceClick: () => void;
}) => {
  const isLibraryMode = homeChatMode === 'library-query';
  const openAttachment = () => {
    if (!isLibraryMode) {
      onUploadSourceClick();
      return;
    }
    onActiveSurfaceChange(activeSurface === 'attachment-menu' ? null : 'attachment-menu');
  };
  return (
    <button
      ref={buttonRef}
      data-home-chat-target="attachment"
      type="button"
      onClick={openAttachment}
      disabled={!isLibraryMode && assessmentMessages.length > 0}
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-200/60 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300"
      title={
        isLibraryMode
          ? t('Apri esploratore contesto libreria')
          : t('Allega un file sorgente (PDF, ZIP, testo)')
      }
      aria-haspopup={isLibraryMode ? 'menu' : undefined}
      aria-expanded={isLibraryMode && activeSurface === 'attachment-menu'}
    >
      <Paperclip className="h-[1.1rem] w-[1.1rem]" />
      {isLibraryMode && attachedContextCount > 0 ? (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#b45c28] px-1 text-[0.6rem] font-semibold leading-none text-white dark:bg-[#e4a477] dark:text-stone-950">
          {attachedContextCount}
        </span>
      ) : null}
    </button>
  );
};

const LibraryToolsButton = ({
  activeSurface,
  activeToolCount,
  buttonRef,
  onActiveSurfaceChange,
}: {
  readonly activeSurface: HomeChatSurfaceState;
  readonly activeToolCount: number;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly onActiveSurfaceChange: (surface: HomeChatSurfaceState) => void;
}) => (
  <button
    ref={buttonRef}
    type="button"
    onClick={() => onActiveSurfaceChange(activeSurface === 'tool-menu' ? null : 'tool-menu')}
    className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
      activeToolCount > 0
        ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:hover:bg-orange-500/25'
        : 'text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300'
    }`}
    title={t('Apri strumenti libreria')}
    aria-expanded={activeSurface === 'tool-menu'}
    aria-haspopup="menu"
  >
    <Plus className="h-[1.1rem] w-[1.1rem]" />
    {activeToolCount > 0 ? (
      <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#b45c28] px-1 text-[0.6rem] font-semibold leading-none text-white dark:bg-[#e4a477] dark:text-stone-950">
        {activeToolCount}
      </span>
    ) : null}
  </button>
);

const DesktopToolMenu = ({
  libraryGenerateArtifacts,
  libraryWebSearch,
  menuAlign,
  menuRef,
  menuVerticalPlacement,
  onLibraryGenerateArtifactsChange,
  onLibraryWebSearchChange,
}: {
  readonly libraryGenerateArtifacts: boolean;
  readonly libraryWebSearch: boolean;
  readonly menuAlign: MenuAlign;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly menuVerticalPlacement: MenuVerticalPlacement;
  readonly onLibraryGenerateArtifactsChange: (value: boolean) => void;
  readonly onLibraryWebSearchChange: (value: boolean) => void;
}) => (
  <div
    ref={menuRef}
    className={`absolute z-30 w-[19rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 p-2 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-600 dark:bg-stone-800/95 ${
      menuVerticalPlacement === 'above' ? 'bottom-[calc(100%+0.75rem)]' : 'top-[calc(100%+0.75rem)]'
    } ${menuAlign === 'end' ? 'right-0' : 'left-0'}`}
    role="menu"
  >
    <ToolOption
      enabled={libraryWebSearch}
      onChange={() => onLibraryWebSearchChange(!libraryWebSearch)}
      icon={Globe}
      label={t('Cerca sul web')}
      description={t(
        'Aggiunge grounding esterno quando servono confronti, suggerimenti di corsi o dati aggiornati.'
      )}
      mobile={false}
    />
    <ToolOption
      enabled={libraryGenerateArtifacts}
      onChange={() => onLibraryGenerateArtifactsChange(!libraryGenerateArtifacts)}
      icon={Sparkles}
      label={t('Genera artefatti visuali')}
      description={t(
        'Crea automaticamente mappe, grafici, diagrammi e widget per visualizzare i concetti trattati.'
      )}
      mobile={false}
    />
  </div>
);

const MobileToolDialog = ({
  close,
  libraryGenerateArtifacts,
  libraryWebSearch,
  onLibraryGenerateArtifactsChange,
  onLibraryWebSearchChange,
}: {
  readonly close: () => void;
  readonly libraryGenerateArtifacts: boolean;
  readonly libraryWebSearch: boolean;
  readonly onLibraryGenerateArtifactsChange: (value: boolean) => void;
  readonly onLibraryWebSearchChange: (value: boolean) => void;
}) => (
  <dialog
    open
    aria-modal="true"
    className="fixed inset-0 z-[55] m-0 flex h-full max-h-none w-full max-w-none items-end border-0 bg-black/30 p-3 md:hidden"
  >
    <button type="button" className="absolute inset-0" aria-label={t('Chiudi')} onClick={close} />
    <div className="relative z-10 w-full rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
            {t('Strumenti libreria')}
          </p>
          <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
            {t('Preferenze risposta')}
          </h4>
        </div>
        <button
          type="button"
          onClick={close}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ToolOption
        enabled={libraryWebSearch}
        onChange={() => onLibraryWebSearchChange(!libraryWebSearch)}
        icon={Globe}
        label={t('Cerca sul web')}
        description={t(
          'Da usare insieme ai dati della libreria quando vuoi confronti o suggerimenti oltre la libreria.'
        )}
        mobile
      />
      <ToolOption
        className="mt-3"
        enabled={libraryGenerateArtifacts}
        onChange={() => onLibraryGenerateArtifactsChange(!libraryGenerateArtifacts)}
        icon={Sparkles}
        label={t('Genera artefatti visuali')}
        description={t(
          'Crea mappe, grafici e diagrammi per visualizzare i concetti insieme alle risposte.'
        )}
        mobile
      />
    </div>
  </dialog>
);

export default function HomeChatComposer({
  activeSurface,
  assessmentComplete,
  assessmentMessages,
  compactSurface = false,
  draftTemplate,
  draftValueOverride,
  homeChatMode,
  inputPlaceholder,
  inputRef,
  isLibraryLoading,
  isLoading,
  isMobileViewport,
  libraryAttachedContextRefs,
  libraryGenerateArtifacts,
  libraryTree,
  libraryWebSearch,
  onClearPendingFile,
  onActiveSurfaceChange,
  onLibraryGenerateArtifactsChange,
  onLibraryMessageSend,
  onLibraryWebSearchChange,
  onSendAssessmentMessage,
  onStopGeneration,
  onToggleLibraryContextRef,
  onUploadSourceClick,
  pendingFileName,
  pendingFileNames,
  viewportHeight,
}: HomeChatComposerProps) {
  const displayedPendingFileNames = useMemo(
    () => getDisplayedPendingFileNames(pendingFileName, pendingFileNames),
    [pendingFileName, pendingFileNames]
  );
  const displayedPendingFiles = useMemo(() => {
    const occurrences = new Map<string, number>();
    return displayedPendingFileNames.map(name => {
      const occurrence = (occurrences.get(name) || 0) + 1;
      occurrences.set(name, occurrence);
      return { key: `${name}-${occurrence}`, name };
    });
  }, [displayedPendingFileNames]);
  const [draftByMode, setDraftByMode] = useState<Record<HomeChatMode, string>>({
    'library-query': homeChatMode === 'library-query' ? draftTemplate?.value || '' : '',
    'new-course': homeChatMode === 'new-course' ? draftTemplate?.value || '' : '',
  });
  const [hasRequestedStop, setHasRequestedStop] = useState(false);
  const [hasStopFailure, setHasStopFailure] = useState(false);
  const [isStopRequestPending, setIsStopRequestPending] = useState(false);
  const [toolMenuAlign, setToolMenuAlign] = useState<MenuAlign>('start');
  const [attachmentMenuAlign, setAttachmentMenuAlign] = useState<MenuAlign>('start');
  const [toolMenuVerticalPlacement, setToolMenuVerticalPlacement] =
    useState<MenuVerticalPlacement>('above');
  const [attachmentMenuVerticalPlacement, setAttachmentMenuVerticalPlacement] =
    useState<MenuVerticalPlacement>('above');
  const toolMenuButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const surfaceRootRef = useRef<HTMLDivElement>(null);
  const attachedContextProjectIds = useMemo(
    () => getAttachedContextProjectIds(libraryAttachedContextRefs, libraryTree),
    [libraryAttachedContextRefs, libraryTree]
  );
  const currentDraft = draftValueOverride ?? draftByMode[homeChatMode];
  const isStoppingGeneration = isStopRequestPending || (isLoading && hasRequestedStop);
  const isGenerationActive = isLoading || isStopRequestPending || hasStopFailure;
  const activeLibraryToolCount = Number(libraryWebSearch) + Number(libraryGenerateArtifacts);
  const closeMenus = () => onActiveSurfaceChange(null);
  const sendButtonLabel = t(homeChatMode === 'new-course' ? 'Inizia' : 'Invia domanda libreria');
  const submitButtonLabel = isGenerationActive && onStopGeneration ? t('Annulla') : sendButtonLabel;

  useLayoutEffect(() => {
    if (
      !isMobileViewport ||
      viewportHeight == null ||
      document.activeElement !== inputRef.current
    ) {
      return;
    }
    inputRef.current?.scrollIntoView({ block: 'nearest' });
  }, [inputRef, isMobileViewport, viewportHeight]);

  useEffect(() => {
    if (!draftTemplate) return;
    const targetMode = draftTemplate.mode ?? homeChatMode;
    if (targetMode !== homeChatMode) return;
    globalThis.window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (draftTemplate.selection) {
        inputRef.current?.setSelectionRange(
          draftTemplate.selection.start,
          draftTemplate.selection.end
        );
      }
    });
  }, [draftTemplate, homeChatMode, inputRef]);

  useEffect(() => {
    if (!isMobileViewport && draftValueOverride === undefined) inputRef.current?.focus();
  }, [draftValueOverride, inputRef, isMobileViewport]);

  useLayoutEffect(() => {
    if (!activeSurface) return;
    const menuContentMeasurementKey =
      activeSurface === 'attachment-menu'
        ? `${isLibraryLoading}:${libraryTree.rootNodes.length}`
        : activeSurface;
    if (!menuContentMeasurementKey) return;
    const anchor =
      activeSurface === 'tool-menu' ? toolMenuButtonRef.current : attachmentButtonRef.current;
    const menu = activeSurface === 'tool-menu' ? toolMenuRef.current : attachmentMenuRef.current;
    if (!anchor || !menu) return;

    const updateMenuPlacement = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const align: MenuAlign =
        anchorRect.left > globalThis.window.innerWidth * 0.62 ? 'end' : 'start';
      const verticalPlacement = getMenuVerticalPlacement(
        anchorRect,
        menuRect.height,
        globalThis.window.innerHeight
      );
      if (activeSurface === 'tool-menu') {
        setToolMenuAlign(current => (current === align ? current : align));
        setToolMenuVerticalPlacement(current =>
          current === verticalPlacement ? current : verticalPlacement
        );
        return;
      }
      setAttachmentMenuAlign(current => (current === align ? current : align));
      setAttachmentMenuVerticalPlacement(current =>
        current === verticalPlacement ? current : verticalPlacement
      );
    };

    updateMenuPlacement();
    globalThis.window.addEventListener('resize', updateMenuPlacement);
    return () => globalThis.window.removeEventListener('resize', updateMenuPlacement);
  }, [activeSurface, isLibraryLoading, libraryTree.rootNodes.length]);

  useEffect(() => {
    if (!activeSurface) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || surfaceRootRef.current?.contains(target)) return;
      onActiveSurfaceChange(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [activeSurface, onActiveSurfaceChange]);

  useEffect(() => {
    if (!activeSurface || !isMobileViewport) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onActiveSurfaceChange(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [activeSurface, isMobileViewport, onActiveSurfaceChange]);

  const updateDraft = (value: string) => {
    setDraftByMode(current => ({ ...current, [homeChatMode]: value }));
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = currentDraft.trim();
    if (!message) return;
    setHasRequestedStop(false);
    setHasStopFailure(false);
    updateDraft('');
    closeMenus();
    if (homeChatMode === 'new-course') {
      await onSendAssessmentMessage(message);
      return;
    }
    await onLibraryMessageSend(message);
  };

  const stopGeneration = () => {
    if (!onStopGeneration || isStoppingGeneration) return;
    setHasRequestedStop(true);
    setHasStopFailure(false);
    setIsStopRequestPending(true);
    closeMenus();
    try {
      void Promise.resolve(onStopGeneration()).then(
        succeeded => {
          setIsStopRequestPending(false);
          if (succeeded === false) {
            setHasRequestedStop(false);
            setHasStopFailure(true);
          }
        },
        () => {
          setIsStopRequestPending(false);
          setHasRequestedStop(false);
          setHasStopFailure(true);
        }
      );
    } catch {
      setIsStopRequestPending(false);
      setHasRequestedStop(false);
      setHasStopFailure(true);
    }
  };

  return (
    <div
      ref={surfaceRootRef}
      className={`max-md:shrink-0 ${
        compactSurface
          ? 'border-0 p-0'
          : 'border-t border-gray-100 px-4 pb-4 pt-3 dark:border-zinc-700/50 sm:px-5'
      }`}
    >
      {homeChatMode === 'new-course' ? (
        <PendingFilesNotice
          assessmentMessages={assessmentMessages}
          displayedPendingFileNames={displayedPendingFileNames}
          displayedPendingFiles={displayedPendingFiles}
          onClearPendingFile={onClearPendingFile}
        />
      ) : null}

      <div className="relative">
        <form
          onSubmit={submit}
          className="relative flex items-center gap-1.5 rounded-2xl border border-gray-300 bg-white px-2 py-1.5 transition-colors focus-within:border-gray-400 dark:border-zinc-600/60 dark:bg-stone-700/60 dark:focus-within:border-zinc-500 dark:focus-within:bg-stone-700"
        >
          <AttachmentButton
            activeSurface={activeSurface}
            assessmentMessages={assessmentMessages}
            attachedContextCount={attachedContextProjectIds.size}
            buttonRef={attachmentButtonRef}
            homeChatMode={homeChatMode}
            onActiveSurfaceChange={onActiveSurfaceChange}
            onUploadSourceClick={onUploadSourceClick}
          />

          {homeChatMode === 'library-query' ? (
            <LibraryToolsButton
              activeSurface={activeSurface}
              activeToolCount={activeLibraryToolCount}
              buttonRef={toolMenuButtonRef}
              onActiveSurfaceChange={onActiveSurfaceChange}
            />
          ) : null}

          <input
            ref={inputRef}
            data-home-chat-target="objective"
            type="text"
            value={currentDraft}
            onChange={event => updateDraft(event.target.value)}
            onFocus={() => {
              if (isMobileViewport && inputRef.current) {
                globalThis.window.requestAnimationFrame(() =>
                  inputRef.current?.scrollIntoView({ block: 'nearest' })
                );
              }
            }}
            placeholder={getComposerPlaceholder(homeChatMode, assessmentComplete, inputPlaceholder)}
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            disabled={isGenerationActive}
          />
          <SpeechInputButton
            disabled={isGenerationActive}
            onTranscription={transcription => {
              setDraftByMode(current => ({
                ...current,
                [homeChatMode]: appendSpeechTranscription(current[homeChatMode], transcription),
              }));
              globalThis.window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
            variant="compact"
          />
          <button
            type={isGenerationActive && onStopGeneration ? 'button' : 'submit'}
            data-home-chat-target="submit"
            onClick={isGenerationActive && onStopGeneration ? stopGeneration : undefined}
            disabled={
              isGenerationActive ? !onStopGeneration || isStoppingGeneration : !currentDraft.trim()
            }
            aria-busy={isStoppingGeneration || undefined}
            aria-label={submitButtonLabel}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
              isGenerationActive
                ? 'bg-orange-500 text-white'
                : 'bg-gray-900 text-white hover:bg-black disabled:bg-gray-200 disabled:text-gray-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500'
            }`}
            title={submitButtonLabel}
          >
            {isStoppingGeneration || (isGenerationActive && !onStopGeneration) ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isGenerationActive ? (
              <Square className="h-3.5 w-3.5 fill-current" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>

          {homeChatMode === 'library-query' &&
          activeSurface === 'tool-menu' &&
          !isMobileViewport ? (
            <DesktopToolMenu
              libraryGenerateArtifacts={libraryGenerateArtifacts}
              libraryWebSearch={libraryWebSearch}
              menuAlign={toolMenuAlign}
              menuRef={toolMenuRef}
              menuVerticalPlacement={toolMenuVerticalPlacement}
              onLibraryGenerateArtifactsChange={onLibraryGenerateArtifactsChange}
              onLibraryWebSearchChange={onLibraryWebSearchChange}
            />
          ) : null}
        </form>

        {homeChatMode === 'library-query' && activeSurface === 'attachment-menu' ? (
          <HomeChatLibraryContextPicker
            attachedContextRefs={libraryAttachedContextRefs}
            close={closeMenus}
            isLibraryLoading={isLibraryLoading}
            isMobileViewport={isMobileViewport}
            libraryTree={libraryTree}
            menuAlign={attachmentMenuAlign}
            menuRef={attachmentMenuRef}
            menuVerticalPlacement={attachmentMenuVerticalPlacement}
            onToggleContextRef={onToggleLibraryContextRef}
            onUploadSourceClick={onUploadSourceClick}
          />
        ) : null}
      </div>

      {homeChatMode === 'library-query' && activeSurface === 'tool-menu' && isMobileViewport ? (
        <MobileToolDialog
          close={closeMenus}
          libraryGenerateArtifacts={libraryGenerateArtifacts}
          libraryWebSearch={libraryWebSearch}
          onLibraryGenerateArtifactsChange={onLibraryGenerateArtifactsChange}
          onLibraryWebSearchChange={onLibraryWebSearchChange}
        />
      ) : null}
    </div>
  );
}
