import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  Flame,
  Folder,
  FolderPlus,
  Heart,
  Home,
  Library,
  Loader2,
  Moon,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { ChangeEvent, ComponentProps, FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import logoUrl from '@/assets/logo.svg';
import logoDarkModeUrl from '@/assets/logo_darkmode.svg';
import { useLearningActivity } from '../../hooks/library/useLearningActivity.ts';
import { usePersistedLibraryFolderExpansion } from '../../hooks/library/usePersistedLibraryFolderExpansion.ts';
import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { createFileObjectUrl } from '../../services/projects/projectSource.ts';
import type {
  FileData,
  LibraryFolder,
  LibraryTree,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';
import { subscribeToMediaQuery } from '../../utils/mediaQuery.ts';
import { Pressable } from '../../utils/motion/index.ts';
import AccountMenu from '../account/AccountMenu.tsx';
import HomeChatPanel from '../library/HomeChatPanel.tsx';
import MarkdownRenderer from '../shared/MarkdownRenderer.tsx';
import SurfaceErrorBoundary from '../shared/SurfaceErrorBoundary.tsx';
import {
  decodeSourceText,
  resolveSourceLibraryItemFile,
  type SourceLibraryItem,
  useCourseCoverImages,
  useFavoriteProjectIds,
  useSourceLibrary,
} from './newHomeData.ts';

type ChatProps = ComponentProps<typeof HomeChatPanel>;
type ChatDraftTemplate = NonNullable<ChatProps['draftTemplate']>;
type CourseFilter = 'all' | 'favorites' | `folder:${string}`;
type SourceFilter = 'all' | SourceLibraryItem['kind'];
type NewHomePage = 'home' | 'library';

const PHONE_VIEWPORT_MEDIA_QUERY = '(max-width: 639px)';
const PHONE_RESUME_PROJECT_LIMIT = 1;
const DEFAULT_RESUME_PROJECT_LIMIT = 3;

const readIsPhoneViewport = (): boolean =>
  typeof globalThis.matchMedia === 'function' &&
  globalThis.matchMedia(PHONE_VIEWPORT_MEDIA_QUERY).matches;

const getNewHomePageFromLocation = (): NewHomePage =>
  typeof globalThis.window !== 'undefined' &&
  (globalThis.window.location.pathname === '/library' ||
    globalThis.window.location.pathname.startsWith('/newhome/library'))
    ? 'library'
    : 'home';

const GENERATED_COURSE_COVER_BY_TITLE: Record<string, string> = {
  'Cloud Computing: dai sistemi distribuiti alle architetture cloud':
    '/new-home/covers/cloud-computing.png',
  'Cybersecurity pratica per sviluppatori Node.js, Express e PostgreSQL':
    '/new-home/covers/cybersecurity.png',
  'Disegno digitale per personaggi: dalle forme alle storie':
    '/new-home/covers/digital-character-design.png',
};

const buildCoursePromptTemplate = (prefix: string, suffix: string): ChatDraftTemplate => {
  const placeholder = t('nome del corso');
  return {
    id: `${prefix}-${Date.now()}`,
    mode: 'library-query',
    selection: { start: prefix.length, end: prefix.length + placeholder.length },
    value: `${prefix}${placeholder}${suffix}`,
  };
};

interface NewHomeViewProps {
  readonly chatProps: ChatProps;
  readonly isDarkMode: boolean;
  readonly isExportingProject: boolean;
  readonly isLibraryLoading: boolean;
  readonly libraryFolders: LibraryFolder[];
  readonly libraryTree: LibraryTree;
  readonly loadProjectCover: (projectId: string) => Promise<FileData | null>;
  readonly loadProjectSource: (projectId: string) => Promise<FileData | null>;
  readonly loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  readonly onCreateFolder: (args: {
    name: string;
    parentFolderId?: string | null;
  }) => Promise<unknown>;
  readonly onConfirmDeleteFolder?: (folderName: string) => Promise<boolean>;
  readonly onDeleteFolder?: (folderId: string) => Promise<void>;
  readonly onDeleteProject?: (projectId: string) => void | Promise<void>;
  readonly onExportLibraryBackup?: () => Promise<number>;
  readonly onExportProject?: (projectId: string) => Promise<void>;
  readonly onImportLibraryBackup?: (file: File) => Promise<number>;
  readonly onImportProjectFile?: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onOpenProject: (projectId: string) => void;
  readonly openingProjectId: string | null;
  readonly onRenameFolder?: (folderId: string, name: string) => Promise<unknown>;
  readonly onRenameProject?: (projectId: string, title: string) => Promise<unknown>;
  readonly onSetProjectFavorite?: (projectId: string, isFavorite: boolean) => Promise<unknown>;
  readonly onToggleDarkMode: () => void;
  readonly projects: SavedProjectMeta[];
  readonly saveProjectCover: (projectId: string, cover: FileData) => Promise<void>;
}

const getCourseProgress = (project: SavedProjectMeta): number =>
  project.lessonCount > 0 ? Math.round((project.completedCount / project.lessonCount) * 100) : 0;

const formatCourseDate = (value: string): string =>
  new Intl.DateTimeFormat(getAppLocale() === 'it' ? 'it-IT' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const matchesSearch = (value: string, query: string): boolean =>
  value.toLocaleLowerCase(getAppLocale()).includes(query.trim().toLocaleLowerCase(getAppLocale()));

const getCourseCoverUrl = (
  project: SavedProjectMeta,
  coverImages: Record<string, string>
): string | undefined => coverImages[project.id] || GENERATED_COURSE_COVER_BY_TITLE[project.title];

const CourseCover = ({ imageUrl, title }: { imageUrl?: string; title: string }) => (
  <div className="flex h-full w-full items-center justify-center overflow-hidden bg-[#eee9df] dark:bg-[#171615]">
    {imageUrl ? (
      <img
        src={imageUrl}
        alt={t('Copertina di {courseTitle}', { courseTitle: title })}
        className="h-full w-full object-cover"
      />
    ) : (
      <>
        <img src={logoUrl} alt="" className="h-12 w-12 object-contain opacity-55 dark:hidden" />
        <img
          src={logoDarkModeUrl}
          alt=""
          className="hidden h-12 w-12 object-contain opacity-60 dark:block"
        />
      </>
    )}
  </div>
);

const SidebarProgress = ({
  averageCompletion,
  streakDays,
  studyTimeLabel,
}: {
  averageCompletion: number;
  streakDays: number;
  studyTimeLabel: string;
}) => (
  <section className="mt-7 border-t border-stone-200/80 pt-6 dark:border-white/10">
    <p className="px-2 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-stone-400">
      {t('Progresso')}
    </p>
    <dl className="mt-4 space-y-4 px-2">
      <div className="flex items-center gap-3">
        <Flame className="h-4 w-4 shrink-0 text-orange-500 dark:text-[#f1c6a8]" />
        <div>
          <dt className="text-[0.68rem] text-stone-400">{t('Learning streak')}</dt>
          <dd className="mt-0.5 text-sm font-medium text-stone-800 dark:text-stone-100">
            {t('{streakDays} giorni', { streakDays })}
          </dd>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Clock3 className="h-4 w-4 shrink-0 text-stone-500 dark:text-stone-400" />
        <div>
          <dt className="text-[0.68rem] text-stone-400">{t('Tempo di studio')}</dt>
          <dd className="mt-0.5 text-sm font-medium text-stone-800 dark:text-stone-100">
            {studyTimeLabel}
          </dd>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-[0.68rem] text-stone-400">{t('Media completamento')}</dt>
          <dd className="text-sm font-semibold text-stone-800 dark:text-stone-100">
            {averageCompletion}%
          </dd>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
          <div
            className="h-full rounded-full bg-[#b9652b] dark:bg-[#d99665]"
            style={{ width: `${averageCompletion}%` }}
          />
        </div>
      </div>
    </dl>
  </section>
);

const NewHomeSidebar = ({
  activePage,
  averageCompletion,
  isDarkMode,
  onExportLibraryBackup,
  onImportLibraryBackup,
  onNavigate,
  onToggleDarkMode,
  streakDays,
  studyTimeLabel,
}: {
  activePage: NewHomePage;
  averageCompletion: number;
  isDarkMode: boolean;
  onExportLibraryBackup?: () => Promise<number>;
  onImportLibraryBackup?: (file: File) => Promise<number>;
  onNavigate: (page: NewHomePage, hash?: string) => void;
  onToggleDarkMode: () => void;
  streakDays: number;
  studyTimeLabel: string;
}) => {
  const logo = isDarkMode ? logoDarkModeUrl : logoUrl;
  const navClass =
    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-stone-100 dark:hover:bg-white/5';

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[13.25rem] flex-col border-r border-stone-200/75 bg-[#faf8f4] px-5 py-6 md:flex dark:border-white/10 dark:bg-[#211d1b]">
      <button
        type="button"
        onClick={() => onNavigate('home')}
        className="flex items-center gap-3 px-1"
      >
        <img src={logo} alt="Nous" className="h-9 w-9 object-contain" />
        <span className="font-serif text-[1.65rem] tracking-[-0.03em] text-stone-950 dark:text-stone-50">
          Nous
        </span>
      </button>

      <nav className="mt-9 space-y-1.5" aria-label={t('Navigazione principale')}>
        <button
          type="button"
          onClick={() => onNavigate('home')}
          aria-current={activePage === 'home' ? 'page' : undefined}
          className={`${navClass} w-full ${
            activePage === 'home'
              ? 'bg-[#f0ebe4] text-[#a65224] dark:bg-white/10 dark:text-[#f1c6a8]'
              : 'text-stone-700 dark:text-stone-300'
          }`}
        >
          <Home className="h-[1.1rem] w-[1.1rem]" /> {t('Home')}
        </button>
        <button
          type="button"
          onClick={() => onNavigate('library')}
          aria-current={activePage === 'library' ? 'page' : undefined}
          className={`${navClass} w-full ${
            activePage === 'library'
              ? 'bg-[#f0ebe4] text-[#a65224] dark:bg-white/10 dark:text-[#f1c6a8]'
              : 'text-stone-700 dark:text-stone-300'
          }`}
        >
          <Library className="h-[1.1rem] w-[1.1rem]" /> {t('Libreria')}
        </button>
      </nav>

      <SidebarProgress
        averageCompletion={averageCompletion}
        streakDays={streakDays}
        studyTimeLabel={studyTimeLabel}
      />

      <div className="mt-auto space-y-1 border-t border-stone-200/80 pt-4 dark:border-white/10">
        <AccountMenu
          onExportLibraryBackup={onExportLibraryBackup}
          onImportLibraryBackup={onImportLibraryBackup}
          triggerVariant="settings"
        />
        <Pressable
          onClick={onToggleDarkMode}
          aria-label={isDarkMode ? t('Usa tema chiaro') : t('Usa tema scuro')}
          className="mt-2 flex h-8 w-full items-center justify-center rounded-xl border border-stone-300 bg-stone-200 text-stone-700 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
        >
          {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Pressable>
      </div>
    </aside>
  );
};

const MobileHeader = ({
  activePage,
  isDarkMode,
  isPhoneViewport,
  onExportLibraryBackup,
  onImportLibraryBackup,
  onNavigate,
  onToggleDarkMode,
}: {
  activePage: NewHomePage;
  isDarkMode: boolean;
  isPhoneViewport: boolean;
  onExportLibraryBackup?: () => Promise<number>;
  onImportLibraryBackup?: (file: File) => Promise<number>;
  onNavigate: (page: NewHomePage) => void;
  onToggleDarkMode: () => void;
}) => (
  <header className="sticky top-0 z-30 flex items-center justify-between border-b border-stone-200/80 bg-[#fdfbf7]/95 px-4 py-2.5 backdrop-blur md:hidden dark:border-white/10 dark:bg-[#252526]/95">
    <button type="button" onClick={() => onNavigate('home')} className="flex items-center gap-2">
      <img
        src={isDarkMode ? logoDarkModeUrl : logoUrl}
        alt="Nous"
        className="h-7 w-7 object-contain"
      />
      <span className="font-serif text-lg">Nous</span>
    </button>
    <nav className="flex items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate('home')}
        className={`rounded-full px-3 py-1.5 ${activePage === 'home' ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : ''}`}
      >
        {t('Home')}
      </button>
      <button
        type="button"
        onClick={() => onNavigate('library')}
        className={`rounded-full px-3 py-1.5 ${activePage === 'library' ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : ''}`}
      >
        {t('Libreria')}
      </button>
    </nav>
    <AccountMenu
      onExportLibraryBackup={onExportLibraryBackup}
      onImportLibraryBackup={onImportLibraryBackup}
      themeToggle={isPhoneViewport ? { isDarkMode, onToggle: onToggleDarkMode } : undefined}
    />
  </header>
);

const TopSearch = ({
  onChange,
  placeholder,
  value,
}: {
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) => (
  <label className="relative block w-full max-w-xl">
    <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
    <input
      type="search"
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      className="h-11 w-full rounded-full border border-stone-200 bg-white/75 pl-11 pr-4 text-sm text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-stone-400 dark:border-white/10 dark:bg-white/5 dark:text-stone-100 dark:focus:border-white/25"
    />
  </label>
);

const CourseProgress = ({ value }: { value: number }) => (
  <div className="flex items-center gap-3">
    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
      <div
        className="h-full rounded-full bg-[#bd6a2d] dark:bg-[#d99665]"
        style={{ width: `${value}%` }}
      />
    </div>
    <span className="w-9 text-right text-xs text-stone-500 dark:text-stone-400">{value}%</span>
  </div>
);

const ResumeSection = ({
  coverImages,
  onOpenProject,
  openingProjectId,
  projects,
}: {
  coverImages: Record<string, string>;
  onOpenProject: (projectId: string) => void;
  openingProjectId: string | null;
  projects: SavedProjectMeta[];
}) => {
  if (projects.length === 0) {
    return null;
  }
  return (
    <section id="recent" className="mt-6 scroll-mt-6 sm:mt-9">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-serif text-[1.4rem] tracking-[-0.02em] text-stone-950 dark:text-stone-50">
          {t('Riprendi da dove eri')}
        </h2>
        <a
          href="#courses"
          className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-white"
        >
          {t('Vedi tutti')}
        </a>
      </div>
      <div className="grid gap-4 min-[900px]:grid-cols-3">
        {projects.map(project => {
          const progress = getCourseProgress(project);
          const isOpening = openingProjectId === project.id;
          return (
            <Pressable
              key={project.id}
              quiet
              onClick={() => onOpenProject(project.id)}
              disabled={isOpening}
              aria-busy={isOpening}
              className="relative overflow-hidden rounded-2xl border border-stone-200/90 bg-white text-left transition-[border-color,box-shadow] hover:border-stone-300 hover:shadow-sm active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 disabled:cursor-wait dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20 dark:focus-visible:ring-stone-300"
            >
              <div className="aspect-[16/7]">
                <CourseCover
                  imageUrl={getCourseCoverUrl(project, coverImages)}
                  title={project.title}
                />
              </div>
              <div className="p-4">
                <p className="line-clamp-2 min-h-11 font-serif text-[1.02rem] leading-snug text-stone-900 dark:text-stone-100">
                  {project.title}
                </p>
                <div className="mt-4 flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                  <span>
                    {t('Lezione {lessonNumber} di {lessonCount}', {
                      lessonNumber: Math.min(project.completedCount + 1, project.lessonCount || 1),
                      lessonCount: project.lessonCount,
                    })}
                  </span>
                  <span>{progress}%</span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                  <div
                    className="h-full rounded-full bg-[#bd6a2d] dark:bg-[#d99665]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
              {isOpening ? (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#fffdf9]/90 text-xs font-medium text-stone-700 backdrop-blur-[2px] dark:bg-[#252526]/90 dark:text-stone-200">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  {t('Apro il corso...')}
                </span>
              ) : null}
            </Pressable>
          );
        })}
      </div>
    </section>
  );
};

interface FolderDialogState {
  initialName: string;
}

interface FloatingMenuState {
  id: string;
  left: number;
  top: number;
}

interface InlineRenameTarget {
  id: string;
  kind: 'folder' | 'project';
  name: string;
}

const getFloatingMenuState = (
  id: string,
  anchor: DOMRect,
  menuWidth: number,
  menuHeight: number
): FloatingMenuState => ({
  id,
  left: Math.max(
    12,
    Math.min(anchor.right - menuWidth, globalThis.window.innerWidth - menuWidth - 12)
  ),
  top:
    anchor.bottom + menuHeight + 8 <= globalThis.window.innerHeight
      ? anchor.bottom + 4
      : Math.max(12, anchor.top - menuHeight - 4),
});

const FolderNameDialog = ({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: FolderDialogState;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) => {
  const [name, setName] = useState(dialog.initialName);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-950/30 px-4 backdrop-blur-[2px]">
      <button
        type="button"
        aria-label={t('Chiudi')}
        className="absolute inset-0"
        onClick={onClose}
      />
      <form
        className="relative w-full max-w-sm rounded-2xl border border-stone-200 bg-[#fffdf9] p-5 shadow-2xl dark:border-white/10 dark:bg-[#211f1e]"
        onSubmit={event => {
          event.preventDefault();
          const trimmedName = name.trim();
          if (!trimmedName || isSaving) return;
          setIsSaving(true);
          void onSubmit(trimmedName).finally(() => setIsSaving(false));
        }}
      >
        <h3 className="font-serif text-xl text-stone-950 dark:text-stone-50">
          {t('Nuova cartella')}
        </h3>
        <label className="mt-5 block text-xs font-medium text-stone-500 dark:text-stone-400">
          {t('Nome')}
          <input
            ref={inputRef}
            value={name}
            onChange={event => setName(event.target.value)}
            className="mt-2 h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/5 dark:text-stone-100"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-white/5"
          >
            {t('Annulla')}
          </button>
          <button
            type="submit"
            disabled={!name.trim() || isSaving}
            className="rounded-full bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
          >
            {isSaving ? t('Salvataggio...') : t('Salva')}
          </button>
        </div>
      </form>
    </div>
  );
};

const CourseList = ({
  coverImages,
  favoriteIds,
  filter,
  isExportingProject,
  isPhoneViewport,
  libraryFolders,
  libraryTree,
  onCreateFolder,
  onConfirmDeleteFolder,
  onDeleteFolder,
  onDeleteProject,
  onExportProject,
  onImportProjectFile,
  onOpenProject,
  openingProjectId,
  onRenameFolder,
  onRenameProject,
  onToggleFavorite,
  onQueryChange,
  projects,
  query,
  setFilter,
}: {
  coverImages: Record<string, string>;
  favoriteIds: string[];
  filter: CourseFilter;
  isExportingProject: boolean;
  isPhoneViewport: boolean;
  libraryFolders: LibraryFolder[];
  libraryTree: LibraryTree;
  onCreateFolder: (args: { name: string }) => Promise<unknown>;
  onConfirmDeleteFolder?: (folderName: string) => Promise<boolean>;
  onDeleteFolder?: (folderId: string) => Promise<void>;
  onDeleteProject?: (projectId: string) => void | Promise<void>;
  onExportProject?: (projectId: string) => Promise<void>;
  onImportProjectFile?: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenProject: (projectId: string) => void;
  openingProjectId: string | null;
  onRenameFolder?: (folderId: string, name: string) => Promise<unknown>;
  onRenameProject?: (projectId: string, title: string) => Promise<unknown>;
  onToggleFavorite: (projectId: string) => void;
  onQueryChange: (query: string) => void;
  projects: SavedProjectMeta[];
  query: string;
  setFilter: (filter: CourseFilter) => void;
}) => {
  const chipViewportRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [dialog, setDialog] = useState<FolderDialogState | null>(null);
  const [renameTarget, setRenameTarget] = useState<InlineRenameTarget | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [openFolderMenu, setOpenFolderMenu] = useState<FloatingMenuState | null>(null);
  const [openCourseMenu, setOpenCourseMenu] = useState<FloatingMenuState | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const renameRequestIdRef = useRef(0);
  const pendingProjectOpenRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsedSpecialGroupIds, setCollapsedSpecialGroupIds] = useState<Set<string>>(
    () => new Set()
  );
  const { expandedFolderIds, toggleFolderExpansion } =
    usePersistedLibraryFolderExpansion(libraryTree);
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  useEffect(
    () => () => {
      if (pendingProjectOpenRef.current) {
        clearTimeout(pendingProjectOpenRef.current);
      }
    },
    []
  );

  const startInlineRename = (target: InlineRenameTarget) => {
    renameRequestIdRef.current += 1;
    setOpenFolderMenu(null);
    setOpenCourseMenu(null);
    setRenameTarget(target);
    setNameDraft(target.name);
    setIsSavingName(false);
    setRenameError('');
  };

  const cancelInlineRename = () => {
    renameRequestIdRef.current += 1;
    setRenameTarget(null);
    setNameDraft('');
    setIsSavingName(false);
    setRenameError('');
  };

  const submitInlineRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameTarget || isSavingName) {
      return;
    }

    const name = nameDraft.trim();
    const rename = renameTarget.kind === 'folder' ? onRenameFolder : onRenameProject;
    if (!name || !rename) {
      return;
    }
    if (name === renameTarget.name) {
      cancelInlineRename();
      return;
    }

    const requestId = renameRequestIdRef.current + 1;
    renameRequestIdRef.current = requestId;
    const target = renameTarget;
    setIsSavingName(true);
    setRenameError('');
    try {
      await rename(target.id, name);
      if (renameRequestIdRef.current === requestId) {
        setRenameTarget(null);
        setNameDraft('');
        setRenameError('');
      }
    } catch (error) {
      console.error('[Nous][Library] Inline rename failed.', error);
      if (renameRequestIdRef.current === requestId) {
        setRenameError(t('Operazione non riuscita. Riprova.'));
      }
    } finally {
      if (renameRequestIdRef.current === requestId) {
        setIsSavingName(false);
      }
    }
  };

  useEffect(() => {
    if (renameTarget) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [renameTarget]);

  const renderInlineRenameForm = (kind: InlineRenameTarget['kind']) => (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      onSubmit={submitInlineRename}
    >
      <input
        ref={nameInputRef}
        value={nameDraft}
        onChange={event => setNameDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelInlineRename();
          }
        }}
        aria-label={t(kind === 'folder' ? 'Rinomina cartella' : 'Rinomina corso')}
        className="h-9 min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-white/15 dark:bg-white/5 dark:text-stone-100"
      />
      <button
        type="submit"
        disabled={!nameDraft.trim() || isSavingName}
        className="text-xs font-medium text-stone-700 disabled:opacity-50 dark:text-stone-200"
      >
        {isSavingName ? t('Salvataggio...') : t('Salva')}
      </button>
      <button
        type="button"
        onClick={cancelInlineRename}
        className="text-xs text-stone-500 dark:text-stone-400"
      >
        {t('Annulla')}
      </button>
      {renameError ? (
        <span role="alert" className="basis-full text-xs text-red-600 dark:text-red-400">
          {renameError}
        </span>
      ) : null}
    </form>
  );
  const folders = useMemo(
    () => [...libraryFolders].sort((left, right) => left.order - right.order),
    [libraryFolders]
  );
  const filteredProjects = projects.filter(project => {
    if (!matchesSearch(project.title, query)) {
      return false;
    }
    if (filter === 'favorites') {
      return favoriteSet.has(project.id);
    }
    if (filter.startsWith('folder:')) {
      return libraryTree.placementByProjectId[project.id]?.folderId === filter.slice(7);
    }
    return true;
  });

  const groups = useMemo(() => {
    if (filter === 'favorites') {
      return [{ id: 'favorites', label: t('Preferiti'), projects: filteredProjects }];
    }
    if (filter.startsWith('folder:')) {
      const folderId = filter.slice(7);
      return [
        {
          id: folderId,
          label: libraryTree.folderById[folderId]?.name || t('Cartella'),
          projects: filteredProjects,
        },
      ];
    }
    const projectsByFolder = new Map<string, SavedProjectMeta[]>();
    filteredProjects.forEach(project => {
      const folderId = libraryTree.placementByProjectId[project.id]?.folderId || 'root';
      projectsByFolder.set(folderId, [...(projectsByFolder.get(folderId) || []), project]);
    });
    const orderedFolderIds = [
      ...folders.map(folder => folder.id).filter(folderId => projectsByFolder.has(folderId)),
      ...(projectsByFolder.has('root') ? ['root'] : []),
    ];
    return orderedFolderIds.map(folderId => ({
      id: folderId,
      label:
        folderId === 'root'
          ? t('Senza cartella')
          : libraryTree.folderById[folderId]?.name || t('Cartella'),
      projects: projectsByFolder.get(folderId) || [],
    }));
  }, [filter, filteredProjects, folders, libraryTree.folderById, libraryTree.placementByProjectId]);

  const updateChipScrollState = useCallback(() => {
    const viewport = chipViewportRef.current;
    if (!viewport) return;
    setCanScrollLeft(viewport.scrollLeft > 2);
    setCanScrollRight(viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 2);
  }, []);

  useEffect(() => {
    updateChipScrollState();
    globalThis.window.addEventListener('resize', updateChipScrollState);
    return () => globalThis.window.removeEventListener('resize', updateChipScrollState);
  }, [updateChipScrollState]);

  const selectFilter = (nextFilter: CourseFilter) => {
    setFilter(filter === nextFilter && nextFilter !== 'all' ? 'all' : nextFilter);
  };

  const scrollChips = (direction: -1 | 1) => {
    chipViewportRef.current?.scrollBy({
      behavior: 'smooth',
      left: direction * (chipViewportRef.current.clientWidth * 0.85),
    });
  };
  const folderMenuGroup = groups.find(group => group.id === openFolderMenu?.id);
  const courseMenuProject = projects.find(project => project.id === openCourseMenu?.id);

  return (
    <section id="courses" className="mt-10 scroll-mt-6">
      <div className="flex items-center justify-between gap-3 sm:flex-wrap sm:gap-4">
        <h2 className="font-serif text-[1.45rem] tracking-[-0.02em] text-stone-950 dark:text-stone-50">
          {t('I tuoi corsi')}
        </h2>
        <div className="flex items-center gap-3">
          {onImportProjectFile ? (
            <label
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-dashed border-stone-200 bg-white px-4 py-2 text-xs font-medium text-stone-600 hover:border-stone-300 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
              title={t('Importa backup Nous (.nous.zip, formato legacy o JSON legacy)')}
            >
              <Download className="h-3.5 w-3.5" /> {t('Importa')}
              <input
                type="file"
                className="hidden"
                accept=".nous.zip,.lumina.zip,.zip,.json,.nous,.lumina"
                onChange={onImportProjectFile}
              />
            </label>
          ) : null}
          {!isPhoneViewport ? (
            <Pressable
              onClick={() => setDialog({ initialName: '' })}
              className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium text-stone-600 hover:border-stone-300 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
            >
              <Plus className="h-3.5 w-3.5" /> {t('Nuova cartella')}
            </Pressable>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex w-full items-center justify-between gap-2 lg:w-[35%] lg:min-w-[16rem]">
          <div className="w-4/5 sm:w-full">
            <TopSearch
              value={query}
              onChange={onQueryChange}
              placeholder={t('Cerca nei tuoi corsi...')}
            />
          </div>
          {isPhoneViewport ? (
            <Pressable
              aria-label={t('Nuova cartella')}
              title={t('Nuova cartella')}
              onClick={() => setDialog({ initialName: '' })}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:bg-white/10"
            >
              <FolderPlus className="h-4 w-4" />
            </Pressable>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {canScrollLeft ? (
            <button
              type="button"
              aria-label={t('Mostra i filtri precedenti')}
              onClick={() => scrollChips(-1)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : null}
          <div
            ref={chipViewportRef}
            onScroll={updateChipScrollState}
            className="new-home-filter-scroll flex min-w-0 flex-1 gap-2 overflow-x-auto py-1"
          >
            {[
              { filter: 'all' as const, label: t('Tutti'), icon: null },
              { filter: 'favorites' as const, label: t('Preferiti'), icon: Heart },
            ].map(option => {
              const Icon = option.icon;
              return (
                <button
                  key={option.filter}
                  type="button"
                  aria-pressed={filter === option.filter}
                  onClick={() => selectFilter(option.filter)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium text-stone-600 aria-pressed:border-stone-900 aria-pressed:bg-stone-900 aria-pressed:text-white dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:aria-pressed:border-stone-100 dark:aria-pressed:bg-stone-100 dark:aria-pressed:text-stone-900"
                >
                  {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
                  {option.label}
                </button>
              );
            })}
            {folders.map(folder => (
              <button
                key={folder.id}
                type="button"
                aria-pressed={filter === `folder:${folder.id}`}
                onClick={() => selectFilter(`folder:${folder.id}`)}
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium text-stone-600 aria-pressed:border-stone-900 aria-pressed:bg-stone-900 aria-pressed:text-white dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:aria-pressed:border-stone-100 dark:aria-pressed:bg-stone-100 dark:aria-pressed:text-stone-900"
              >
                {folder.name}
                <span className="text-[0.65rem] opacity-60">
                  {libraryTree.descendantProjectIdsByFolderId[folder.id]?.length || 0}
                </span>
              </button>
            ))}
          </div>
          {canScrollRight ? (
            <button
              type="button"
              aria-label={t('Mostra altri filtri')}
              onClick={() => scrollChips(1)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-4">
        {groups.map(group => {
          const isLibraryFolder = Boolean(libraryTree.folderById[group.id]);
          const isCollapsed = isLibraryFolder
            ? !expandedFolderIds.has(group.id)
            : collapsedSpecialGroupIds.has(group.id);
          return (
            <div
              key={group.id}
              className="overflow-hidden rounded-2xl border border-stone-200/90 bg-transparent sm:bg-white dark:border-white/10 dark:sm:bg-white/[0.035]"
            >
              <div className="relative flex items-center gap-3 border-b border-stone-100 bg-white px-4 py-3 sm:bg-transparent dark:border-white/10 dark:bg-white/[0.035] dark:sm:bg-transparent">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-label={t(isCollapsed ? 'Espandi {folderName}' : 'Comprimi {folderName}', {
                    folderName: group.label,
                  })}
                  onClick={() => {
                    if (isLibraryFolder) {
                      toggleFolderExpansion(group.id);
                      return;
                    }

                    setCollapsedSpecialGroupIds(current => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    });
                  }}
                  className="rounded-full p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-white/5"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
                <Folder className="h-4 w-4 text-[#c67531] dark:text-[#f1c6a8]" />
                {renameTarget?.kind === 'folder' && renameTarget.id === group.id ? (
                  renderInlineRenameForm('folder')
                ) : (
                  <h3
                    onDoubleClick={() => {
                      if (isLibraryFolder && onRenameFolder) {
                        startInlineRename({ id: group.id, kind: 'folder', name: group.label });
                      }
                    }}
                    className="text-sm font-medium text-stone-800 dark:text-stone-100"
                  >
                    {group.label}
                  </h3>
                )}
                <span className="text-xs text-stone-400">
                  {t('{courseCount} corsi', { courseCount: group.projects.length })}
                </span>
                {group.id !== 'root' && group.id !== 'favorites' ? (
                  <div className="ml-auto">
                    <button
                      type="button"
                      aria-label={t('Azioni per la cartella {folderName}', {
                        folderName: group.label,
                      })}
                      onClick={event => {
                        const anchor = event.currentTarget.getBoundingClientRect();
                        setOpenFolderMenu(current =>
                          current?.id === group.id
                            ? null
                            : getFloatingMenuState(group.id, anchor, 176, 92)
                        );
                      }}
                      className="rounded-full p-2 text-stone-400 hover:bg-stone-100 dark:hover:bg-white/5"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
              </div>
              {isCollapsed
                ? null
                : group.projects.map(project => {
                    const progress = getCourseProgress(project);
                    const isFavorite = favoriteSet.has(project.id);
                    const isOpening = openingProjectId === project.id;
                    return (
                      <div
                        key={project.id}
                        className="group relative flex items-center gap-3 border-b border-stone-200/70 px-2 py-3 last:border-b-0 sm:min-h-0 sm:gap-4 sm:border-stone-200/80 sm:px-4 sm:py-3 dark:border-white/10"
                      >
                        <div className="relative z-10 flex min-w-0 flex-1 items-center gap-4 text-left">
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              onOpenProject(project.id);
                            }}
                            disabled={isOpening}
                            aria-busy={isOpening}
                            className="relative block h-11 w-16 shrink-0 overflow-hidden rounded-lg disabled:cursor-wait"
                          >
                            <div className="relative h-11 w-16 shrink-0 overflow-hidden rounded-lg">
                              {isOpening ? (
                                <span className="absolute inset-0 z-10 flex items-center justify-center bg-[#f3eee6] dark:bg-stone-800">
                                  <Loader2 className="h-5 w-5 animate-spin text-[#a95828] dark:text-[#f1c6a8]" />
                                </span>
                              ) : (
                                <CourseCover
                                  imageUrl={getCourseCoverUrl(project, coverImages)}
                                  title={project.title}
                                />
                              )}
                            </div>
                          </button>
                          <div className="min-w-0 flex-1">
                            {renameTarget?.kind === 'project' && renameTarget.id === project.id ? (
                              renderInlineRenameForm('project')
                            ) : (
                              <>
                                <p className="font-serif text-sm leading-snug text-stone-900 dark:text-stone-100">
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation();
                                      if (!onRenameProject) {
                                        onOpenProject(project.id);
                                        return;
                                      }
                                      if (event.detail === 0) {
                                        onOpenProject(project.id);
                                        return;
                                      }
                                      if (pendingProjectOpenRef.current) {
                                        clearTimeout(pendingProjectOpenRef.current);
                                      }
                                      pendingProjectOpenRef.current = setTimeout(
                                        () => onOpenProject(project.id),
                                        180
                                      );
                                    }}
                                    onDoubleClick={event => {
                                      event.stopPropagation();
                                      if (!onRenameProject) {
                                        return;
                                      }
                                      event.preventDefault();
                                      if (pendingProjectOpenRef.current) {
                                        clearTimeout(pendingProjectOpenRef.current);
                                        pendingProjectOpenRef.current = null;
                                      }
                                      startInlineRename({
                                        id: project.id,
                                        kind: 'project',
                                        name: project.title,
                                      });
                                    }}
                                    className="line-clamp-3 w-full overflow-hidden text-left sm:line-clamp-2"
                                  >
                                    {project.title}
                                  </button>
                                </p>
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation();
                                    onOpenProject(project.id);
                                  }}
                                  disabled={isOpening}
                                  aria-busy={isOpening}
                                  className="mt-1 text-[0.68rem] text-stone-600 disabled:cursor-wait sm:text-stone-400 dark:text-stone-300 dark:sm:text-stone-400"
                                >
                                  {t('{lessonCount} lezioni · {lastOpenedDate}', {
                                    lessonCount: project.lessonCount,
                                    lastOpenedDate: formatCourseDate(project.lastOpenedAt),
                                  })}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="relative z-10 hidden sm:block">
                          <CourseProgress value={progress} />
                        </div>
                        <button
                          type="button"
                          aria-label={
                            isFavorite
                              ? t('Rimuovi {courseTitle} dai preferiti', {
                                  courseTitle: project.title,
                                })
                              : t('Aggiungi {courseTitle} ai preferiti', {
                                  courseTitle: project.title,
                                })
                          }
                          aria-pressed={isFavorite}
                          onClick={event => {
                            event.stopPropagation();
                            onToggleFavorite(project.id);
                          }}
                          disabled={isOpening}
                          className="relative z-10 rounded-full p-2 text-stone-600 hover:bg-stone-100 hover:text-[#b45c28] aria-pressed:text-[#b45c28] sm:text-stone-400 dark:text-stone-300 dark:hover:bg-white/5 dark:hover:text-[#f1c6a8] dark:aria-pressed:text-[#f1c6a8] dark:sm:text-stone-400"
                        >
                          <Heart className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
                        </button>
                        <button
                          type="button"
                          aria-label={t('Azioni per {courseTitle}', {
                            courseTitle: project.title,
                          })}
                          onClick={event => {
                            event.stopPropagation();
                            const anchor = event.currentTarget.getBoundingClientRect();
                            setOpenCourseMenu(current =>
                              current?.id === project.id
                                ? null
                                : getFloatingMenuState(project.id, anchor, 192, 212)
                            );
                          }}
                          disabled={isOpening}
                          className="relative z-10 rounded-full p-2 text-stone-600 hover:bg-stone-100 sm:text-stone-400 dark:text-stone-300 dark:hover:bg-white/5 dark:sm:text-stone-400"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {isOpening ? (
                          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#fdfbf7]/95 sm:hidden dark:bg-[#252526]/95">
                            <Loader2 className="h-6 w-6 animate-spin text-[#a95828] dark:text-[#f1c6a8]" />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
            </div>
          );
        })}
        {openFolderMenu && folderMenuGroup && typeof document !== 'undefined'
          ? createPortal(
              <>
                <button
                  type="button"
                  aria-label={t('Chiudi azioni cartella')}
                  className="fixed inset-0 z-[70]"
                  onClick={() => setOpenFolderMenu(null)}
                />
                <div
                  className="fixed z-[80] w-44 rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#211f1e]"
                  style={{ left: openFolderMenu.left, top: openFolderMenu.top }}
                >
                  {onRenameFolder ? (
                    <button
                      type="button"
                      onClick={() =>
                        startInlineRename({
                          id: folderMenuGroup.id,
                          kind: 'folder',
                          name: folderMenuGroup.label,
                        })
                      }
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-white/5"
                    >
                      <Pencil className="h-4 w-4" /> {t('Rinomina')}
                    </button>
                  ) : null}
                  {onDeleteFolder ? (
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          setOpenFolderMenu(null);
                          if (
                            !onConfirmDeleteFolder ||
                            (await onConfirmDeleteFolder(folderMenuGroup.label))
                          )
                            await onDeleteFolder(folderMenuGroup.id);
                        })();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                      <Trash2 className="h-4 w-4" /> {t('Elimina')}
                    </button>
                  ) : null}
                </div>
              </>,
              document.body
            )
          : null}
        {openCourseMenu && courseMenuProject && typeof document !== 'undefined'
          ? createPortal(
              <>
                <button
                  type="button"
                  aria-label={t('Chiudi azioni corso')}
                  className="fixed inset-0 z-[70]"
                  onClick={() => setOpenCourseMenu(null)}
                />
                <div
                  className="fixed z-[80] w-48 rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#211f1e]"
                  style={{ left: openCourseMenu.left, top: openCourseMenu.top }}
                >
                  {onRenameProject ? (
                    <button
                      type="button"
                      onClick={() =>
                        startInlineRename({
                          id: courseMenuProject.id,
                          kind: 'project',
                          name: courseMenuProject.title,
                        })
                      }
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-white/5"
                    >
                      <Pencil className="h-4 w-4" /> {t('Rinomina')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setOpenCourseMenu(null);
                      onOpenProject(courseMenuProject.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-white/5"
                  >
                    <BookOpen className="h-4 w-4" /> {t('Apri corso')}
                  </button>
                  {onExportProject ? (
                    <button
                      type="button"
                      onClick={() => {
                        void onExportProject(courseMenuProject.id).finally(() => {
                          setOpenCourseMenu(null);
                        });
                      }}
                      disabled={isExportingProject}
                      aria-busy={isExportingProject}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-100 disabled:cursor-wait disabled:opacity-70 dark:text-stone-200 dark:hover:bg-white/5"
                    >
                      {isExportingProject ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}{' '}
                      {isExportingProject ? t('Esportazione...') : t('Esporta')}
                    </button>
                  ) : null}
                  {onDeleteProject ? (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenCourseMenu(null);
                        void onDeleteProject(courseMenuProject.id);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                      <Trash2 className="h-4 w-4" /> {t('Elimina')}
                    </button>
                  ) : null}
                </div>
              </>,
              document.body
            )
          : null}
        {filteredProjects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 px-6 py-10 text-center text-sm text-stone-500 dark:border-white/15 dark:text-stone-400">
            {filter === 'favorites'
              ? t('Non hai ancora aggiunto corsi ai preferiti.')
              : t('Nessun corso corrisponde a questa ricerca.')}
          </div>
        ) : null}
      </div>
      {dialog ? (
        <FolderNameDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSubmit={async name => {
            await onCreateFolder({ name });
            setDialog(null);
          }}
        />
      ) : null}
    </section>
  );
};

const HomePage = ({
  chatProps,
  coverImages,
  favoriteIds,
  isExportingProject,
  isPhoneViewport,
  isLibraryLoading,
  libraryFolders,
  libraryTree,
  onCreateFolder,
  onConfirmDeleteFolder,
  onDeleteFolder,
  onDeleteProject,
  onExportProject,
  onImportProjectFile,
  onOpenProject,
  openingProjectId,
  onRenameFolder,
  onRenameProject,
  onToggleFavorite,
  projects,
}: {
  chatProps: ChatProps;
  coverImages: Record<string, string>;
  favoriteIds: string[];
  isExportingProject: boolean;
  isPhoneViewport: boolean;
  isLibraryLoading: boolean;
  libraryFolders: LibraryFolder[];
  libraryTree: LibraryTree;
  onCreateFolder: (args: { name: string }) => Promise<unknown>;
  onConfirmDeleteFolder?: (folderName: string) => Promise<boolean>;
  onDeleteFolder?: (folderId: string) => Promise<void>;
  onDeleteProject?: (projectId: string) => void | Promise<void>;
  onExportProject?: (projectId: string) => Promise<void>;
  onImportProjectFile?: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenProject: (projectId: string) => void;
  openingProjectId: string | null;
  onRenameFolder?: (folderId: string, name: string) => Promise<unknown>;
  onRenameProject?: (projectId: string, title: string) => Promise<unknown>;
  onToggleFavorite: (projectId: string) => void;
  projects: SavedProjectMeta[];
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CourseFilter>('all');
  const [draftTemplate, setDraftTemplate] = useState<ChatDraftTemplate>();
  const hasActiveConversation =
    chatProps.homeChatMode === 'new-course'
      ? chatProps.assessmentMessages.length > 0
      : chatProps.libraryMessages.length > 0;
  const incompleteProjects = projects
    .filter(project => project.lessonCount === 0 || project.completedCount < project.lessonCount)
    .filter(project => matchesSearch(project.title, query))
    .slice(0, isPhoneViewport ? PHONE_RESUME_PROJECT_LIMIT : DEFAULT_RESUME_PROJECT_LIMIT);

  return (
    <>
      <section className="mx-auto mt-7 text-center sm:mt-14">
        <h1 className="scale-x-[0.84] whitespace-nowrap font-serif text-[clamp(1.4rem,6vw,2.25rem)] leading-tight tracking-[-0.045em] text-stone-950 min-[421px]:scale-x-90 sm:text-[clamp(2rem,6vw,3rem)] md:text-[clamp(1.75rem,3.3vw,3rem)] xl:scale-x-100 dark:text-stone-50">
          {t('Cosa vuoi')}{' '}
          <span className="text-[#a95828] dark:text-[#f1c6a8]">{t('imparare')}</span> {t('oggi?')}
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-5 text-stone-500 sm:mt-3 sm:leading-6 dark:text-stone-400">
          {t(
            'Crea un nuovo corso o interroga i tuoi corsi per esplorare, chiarire e collegare le tue conoscenze.'
          )}
        </p>
        <div className="new-home-chat mt-5 text-left sm:mt-7">
          <SurfaceErrorBoundary resetKey={draftTemplate?.id} surface="chat">
            <HomeChatPanel
              key={draftTemplate?.id || 'new-home-chat'}
              {...chatProps}
              draftTemplate={draftTemplate}
              compactWhenEmpty
              hideHeaderCopy
              hideModeSelector
              inputPlaceholder={t('Fai una domanda o allega una fonte...')}
              showChatAvatars
            />
          </SurfaceErrorBoundary>
        </div>
        {!hasActiveConversation ? (
          <div className="new-home-filter-scroll -mx-4 mt-3 flex flex-nowrap gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:mt-4 sm:justify-center sm:px-0">
            <button
              type="button"
              onClick={() => {
                chatProps.onLibraryGenerateArtifactsChange(false);
                chatProps.onHomeChatModeChange('new-course');
                setDraftTemplate({
                  id: `new-course-${Date.now()}`,
                  mode: 'new-course',
                  value: `${t('Voglio che tu crei un corso su')} `,
                });
              }}
              className="shrink-0 whitespace-nowrap rounded-full border border-stone-200 bg-white px-4 py-2 text-xs text-stone-600 hover:border-stone-300 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
            >
              {t('Impara un nuovo argomento')}
            </button>
            <button
              type="button"
              onClick={() => {
                chatProps.onLibraryGenerateArtifactsChange(false);
                chatProps.onHomeChatModeChange('library-query');
                setDraftTemplate(
                  buildCoursePromptTemplate(
                    `${t('Aiutami a ripassare il corso')} `,
                    t(
                      ', prestando particolare attenzione a ciò che ho annotato e sottolineato, ai diagrammi e agli artefatti generati.'
                    )
                  )
                );
              }}
              className="shrink-0 whitespace-nowrap rounded-full border border-stone-200 bg-white px-4 py-2 text-xs text-stone-600 hover:border-stone-300 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
            >
              {t('Ripassami un corso')}
            </button>
            <button
              type="button"
              onClick={() => {
                chatProps.onLibraryGenerateArtifactsChange(true);
                chatProps.onHomeChatModeChange('library-query');
                setDraftTemplate(
                  buildCoursePromptTemplate(
                    `${t('Crea delle flashcard di ripasso come artefatto HTML per il corso')} `,
                    t(', prestando particolare attenzione a ciò che ho annotato e sottolineato.')
                  )
                );
              }}
              className="shrink-0 whitespace-nowrap rounded-full border border-stone-200 bg-white px-4 py-2 text-xs text-stone-600 hover:border-stone-300 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
            >
              {t('Crea flashcard di ripasso')}
            </button>
          </div>
        ) : null}
      </section>

      {isLibraryLoading ? (
        <div className="mt-12 rounded-2xl border border-stone-200 bg-white px-6 py-12 text-center text-sm text-stone-500 dark:border-white/10 dark:bg-white/5 dark:text-stone-400">
          {t('Caricamento dei corsi...')}
        </div>
      ) : (
        <>
          {!hasActiveConversation ? (
            <ResumeSection
              coverImages={coverImages}
              onOpenProject={onOpenProject}
              openingProjectId={openingProjectId}
              projects={incompleteProjects}
            />
          ) : null}
          <CourseList
            coverImages={coverImages}
            favoriteIds={favoriteIds}
            filter={filter}
            isExportingProject={isExportingProject}
            isPhoneViewport={isPhoneViewport}
            libraryFolders={libraryFolders}
            libraryTree={libraryTree}
            onCreateFolder={onCreateFolder}
            onConfirmDeleteFolder={onConfirmDeleteFolder}
            onDeleteFolder={onDeleteFolder}
            onDeleteProject={onDeleteProject}
            onExportProject={onExportProject}
            onImportProjectFile={onImportProjectFile}
            onOpenProject={onOpenProject}
            openingProjectId={openingProjectId}
            onQueryChange={setQuery}
            onRenameFolder={onRenameFolder}
            onRenameProject={onRenameProject}
            onToggleFavorite={onToggleFavorite}
            projects={projects}
            query={query}
            setFilter={setFilter}
          />
        </>
      )}
    </>
  );
};

const getSourceIcon = (kind: SourceLibraryItem['kind']) => {
  if (kind === 'archive') {
    return FileArchive;
  }
  if (kind === 'pdf') {
    return FileText;
  }
  if (kind === 'markdown') {
    return FileCode2;
  }
  return BookOpen;
};

const getSourceKindLabel = (item: SourceLibraryItem): string => {
  if (item.kind === 'archive') {
    return t('Archivio');
  }
  if (item.kind === 'pdf') {
    return 'PDF';
  }
  return item.kind === 'markdown' ? 'Markdown' : t('Testo');
};

const SourceViewerContent = ({
  file,
  isDarkMode,
  item,
  objectUrl,
}: {
  file: FileData;
  isDarkMode: boolean;
  item: SourceLibraryItem;
  objectUrl: string | null;
}) => {
  if (item.kind === 'archive') {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
        <FileArchive className="h-12 w-12 text-[#a95828] dark:text-[#f1c6a8]" />
        <p className="mt-5 text-sm leading-6 text-stone-600 dark:text-stone-300">
          {t('Archivio originale del corso')}
        </p>
        {objectUrl ? (
          <a
            className="mt-5 rounded-full bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
            download={file.name}
            href={objectUrl}
          >
            {t('Scarica archivio originale')}
          </a>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'pdf') {
    return objectUrl ? (
      <iframe src={objectUrl} title={file.name} className="h-full w-full border-0" />
    ) : (
      <p className="p-8 text-center text-sm text-stone-500">{t('Caricamento PDF...')}</p>
    );
  }

  if (item.kind === 'markdown') {
    return (
      <article className="mx-auto max-w-4xl px-6 py-10 sm:px-10">
        <MarkdownRenderer
          content={decodeSourceText(file)}
          isDarkMode={isDarkMode}
          className="max-w-none dark:prose-invert"
        />
      </article>
    );
  }

  return (
    <pre className="mx-auto max-w-5xl whitespace-pre-wrap break-words px-6 py-10 font-sans text-sm leading-7 text-stone-800 dark:text-stone-200">
      {decodeSourceText(file)}
    </pre>
  );
};

const SourceViewer = ({
  file,
  isDarkMode,
  item,
  onClose,
}: {
  file: FileData;
  isDarkMode: boolean;
  item: SourceLibraryItem;
  onClose: () => void;
}) => {
  const [objectUrl] = useState(() =>
    item.kind === 'pdf' || item.kind === 'archive' ? createFileObjectUrl(file) : null
  );
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-[#fdfbf7] dark:bg-[#252526]">
      <header className="flex items-center gap-4 border-b border-stone-200 px-4 py-3 dark:border-white/10">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('Chiudi fonte')}
          className="flex h-10 w-10 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/5"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate font-serif text-lg text-stone-950 dark:text-stone-50">
            {file.name}
          </h2>
          <p className="truncate text-xs text-stone-400">{item.projectTitle}</p>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <SourceViewerContent
          file={file}
          isDarkMode={isDarkMode}
          item={item}
          objectUrl={objectUrl}
        />
      </main>
    </div>,
    document.body
  );
};

const SourceLibraryPage = ({
  isDarkMode,
  isLoading,
  items,
  loadProjectSource,
}: {
  isDarkMode: boolean;
  isLoading: boolean;
  items: SourceLibraryItem[];
  loadProjectSource: (projectId: string) => Promise<FileData | null>;
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [openingItemId, setOpeningItemId] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [viewer, setViewer] = useState<{ file: FileData; item: SourceLibraryItem } | null>(null);
  const filteredItems = useMemo(
    () =>
      items.filter(item => {
        const matchesType = filter === 'all' || item.kind === filter;
        return (
          matchesType &&
          (matchesSearch(item.file.name, query) || matchesSearch(item.projectTitle, query))
        );
      }),
    [filter, items, query]
  );
  const sourceGroups = useMemo(() => {
    const groups = new Map<string, { id: string; items: SourceLibraryItem[]; title: string }>();
    for (const item of filteredItems) {
      const group = groups.get(item.projectId);
      if (group) group.items.push(item);
      else
        groups.set(item.projectId, {
          id: item.projectId,
          items: [item],
          title: item.projectTitle,
        });
    }
    return [...groups.values()];
  }, [filteredItems]);

  return (
    <>
      <header className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#a95828] dark:text-[#f1c6a8]">
          {t('Libreria')}
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-[-0.04em] text-stone-950 sm:text-5xl dark:text-stone-50">
          {t('Le tue fonti, tutte insieme')}
        </h1>
        <p className="mt-4 text-sm leading-6 text-stone-500 dark:text-stone-400">
          {t('Apri i materiali originali dei tuoi corsi e torna subito alla fonte che ti serve.')}
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="w-full lg:w-[35%] lg:min-w-[16rem]">
          <TopSearch value={query} onChange={setQuery} placeholder={t('Cerca nella Libreria...')} />
        </div>
        <div className="new-home-filter-scroll flex min-w-0 flex-1 gap-2 overflow-x-auto py-1">
          {[
            ['all', t('Tutte')],
            ['pdf', 'PDF'],
            ['markdown', 'Markdown'],
            ['text', t('Testo')],
            ['archive', t('Archivio')],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value as SourceFilter)}
              className="shrink-0 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium text-stone-600 aria-pressed:border-stone-900 aria-pressed:bg-stone-900 aria-pressed:text-white dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:aria-pressed:bg-stone-100 dark:aria-pressed:text-stone-900"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <section className="mt-5 overflow-hidden rounded-2xl border border-stone-200/90 bg-white dark:border-white/10 dark:bg-white/[0.035]">
        {isLoading && items.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-stone-500 dark:text-stone-400">
            {t('Raccolgo le fonti dei tuoi corsi...')}
          </p>
        ) : filteredItems.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-stone-500 dark:text-stone-400">
            {t('Nessuna fonte corrisponde a questa ricerca.')}
          </p>
        ) : (
          sourceGroups.map(group => {
            const isExpanded = query.trim().length > 0 || expandedProjectIds.has(group.id);
            return (
              <div
                key={group.id}
                className="border-b border-stone-100 last:border-b-0 dark:border-white/8"
              >
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpandedProjectIds(current => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-[#fbf8f3] dark:hover:bg-white/[0.04]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f3eee6] text-[#a95828] dark:bg-white/10 dark:text-[#f1c6a8]">
                    <Folder className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-serif text-[0.98rem] text-stone-900 dark:text-stone-100">
                      {group.title}
                    </span>
                    <span className="mt-1 block text-xs text-stone-400">
                      {t('{sourceCount} fonti', { sourceCount: group.items.length })}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-stone-400 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </button>
                <div
                  className={`grid transition-[grid-template-rows] duration-300 ease-out ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                >
                  <div
                    className="overflow-hidden"
                    aria-hidden={!isExpanded}
                    inert={!isExpanded || undefined}
                  >
                    {group.items.map(item => {
                      const Icon = getSourceIcon(item.kind);
                      const isOpening = openingItemId === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={isOpening}
                          aria-busy={isOpening}
                          onClick={() => {
                            setOpeningItemId(item.id);
                            void resolveSourceLibraryItemFile(item, loadProjectSource)
                              .then(file => {
                                if (file) setViewer({ file, item });
                              })
                              .finally(() => setOpeningItemId(null));
                          }}
                          className="flex w-full items-center gap-4 border-t border-stone-100 px-5 py-4 pl-9 text-left transition-colors hover:bg-[#fbf8f3] disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/8 dark:hover:bg-white/[0.04]"
                        >
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-100 text-stone-500 dark:bg-white/5 dark:text-stone-300">
                            <Icon className="h-5 w-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-serif text-[0.98rem] text-stone-900 dark:text-stone-100">
                              {item.file.name}
                            </span>
                            <span className="mt-1 block truncate text-xs text-stone-400">
                              {getSourceKindLabel(item)}
                            </span>
                          </span>
                          {isOpening ? (
                            <Loader2 className="h-4 w-4 animate-spin text-[#a95828] dark:text-[#f1c6a8]" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-stone-400" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
        {isLoading && items.length > 0 ? (
          <p className="border-t border-stone-100 px-5 py-4 text-center text-xs text-stone-400 dark:border-white/10">
            {t('Sto caricando le altre fonti...')}
          </p>
        ) : null}
      </section>
      {viewer ? (
        <SourceViewer
          key={viewer.item.id}
          file={viewer.file}
          isDarkMode={isDarkMode}
          item={viewer.item}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  );
};

export const NewHomeView = ({
  chatProps,
  isDarkMode,
  isExportingProject,
  isLibraryLoading,
  libraryFolders,
  libraryTree,
  loadProjectCover,
  loadProjectSource,
  loadProjectsById,
  onCreateFolder,
  onConfirmDeleteFolder,
  onDeleteFolder,
  onDeleteProject,
  onExportLibraryBackup,
  onExportProject,
  onImportLibraryBackup,
  onImportProjectFile,
  onOpenProject,
  openingProjectId,
  onRenameFolder,
  onRenameProject,
  onSetProjectFavorite,
  onToggleDarkMode,
  projects,
  saveProjectCover,
}: NewHomeViewProps) => {
  const [activePage, setActivePage] = useState<NewHomePage>(getNewHomePageFromLocation);
  const [isPhoneViewport, setIsPhoneViewport] = useState(readIsPhoneViewport);
  useEffect(() => {
    const handlePopState = () => setActivePage(getNewHomePageFromLocation());
    globalThis.window.addEventListener('popstate', handlePopState);
    return () => globalThis.window.removeEventListener('popstate', handlePopState);
  }, []);
  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = globalThis.matchMedia(PHONE_VIEWPORT_MEDIA_QUERY);
    const updateViewport = () => setIsPhoneViewport(mediaQuery.matches);
    updateViewport();
    return subscribeToMediaQuery(mediaQuery, updateViewport);
  }, []);
  const navigate = useCallback((page: NewHomePage, hash?: string) => {
    const pathname = page === 'library' ? '/library' : '/';
    const nextUrl = hash ? `${pathname}#${hash}` : pathname;
    globalThis.window.history.pushState({}, '', nextUrl);
    setActivePage(page);
    if (hash) {
      globalThis.window.requestAnimationFrame(() =>
        document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );
    } else {
      globalThis.window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);
  const { streakDays, studyTimeLabel } = useLearningActivity();
  const { favoriteIds, toggleFavoriteProject } = useFavoriteProjectIds(
    projects,
    onSetProjectFavorite
  );
  const coverImages = useCourseCoverImages({
    loadProjectCover,
    projects,
    saveProjectCover,
  });
  const sourceLibrary = useSourceLibrary({
    enabled: activePage === 'library',
    loadProjectsById,
    projects,
  });
  const averageCompletion = useMemo(() => {
    const completableProjects = projects.filter(project => project.lessonCount > 0);
    if (completableProjects.length === 0) {
      return 0;
    }
    return Math.round(
      completableProjects.reduce((total, project) => total + getCourseProgress(project), 0) /
        completableProjects.length
    );
  }, [projects]);

  return (
    <div className="min-h-screen bg-[#fdfbf7] text-stone-900 transition-colors dark:bg-[#252526] dark:text-stone-100">
      <NewHomeSidebar
        activePage={activePage}
        averageCompletion={averageCompletion}
        isDarkMode={isDarkMode}
        onExportLibraryBackup={onExportLibraryBackup}
        onImportLibraryBackup={onImportLibraryBackup}
        onNavigate={navigate}
        onToggleDarkMode={onToggleDarkMode}
        streakDays={streakDays}
        studyTimeLabel={studyTimeLabel}
      />
      <MobileHeader
        activePage={activePage}
        isDarkMode={isDarkMode}
        isPhoneViewport={isPhoneViewport}
        onExportLibraryBackup={onExportLibraryBackup}
        onImportLibraryBackup={onImportLibraryBackup}
        onNavigate={navigate}
        onToggleDarkMode={onToggleDarkMode}
      />
      <main className="px-4 pb-20 pt-3 sm:px-6 sm:pt-5 md:ml-[13.25rem] md:px-8 md:pt-6 lg:px-12">
        <div className="mx-auto max-w-[76rem]">
          {activePage === 'library' ? (
            <SourceLibraryPage
              isDarkMode={isDarkMode}
              isLoading={sourceLibrary.isLoading}
              items={sourceLibrary.items}
              loadProjectSource={loadProjectSource}
            />
          ) : (
            <HomePage
              chatProps={chatProps}
              coverImages={coverImages}
              favoriteIds={favoriteIds}
              isExportingProject={isExportingProject}
              isPhoneViewport={isPhoneViewport}
              isLibraryLoading={isLibraryLoading}
              libraryFolders={libraryFolders}
              libraryTree={libraryTree}
              onCreateFolder={onCreateFolder}
              onConfirmDeleteFolder={onConfirmDeleteFolder}
              onDeleteFolder={onDeleteFolder}
              onDeleteProject={onDeleteProject}
              onExportProject={onExportProject}
              onImportProjectFile={onImportProjectFile}
              onOpenProject={onOpenProject}
              openingProjectId={openingProjectId}
              onRenameFolder={onRenameFolder}
              onRenameProject={onRenameProject}
              onToggleFavorite={toggleFavoriteProject}
              projects={projects}
            />
          )}
        </div>
      </main>
    </div>
  );
};
