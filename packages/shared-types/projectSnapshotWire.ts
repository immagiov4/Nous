import { deriveLegacyLessonContent, LESSON_MARKDOWN_BLOCK_TYPE } from './lessonContent';
import type { ProjectSourceKind } from './projectContract';
import { isSourceArchivePdfWarningReason } from './sourceArchiveWarnings';

export const PROJECT_SNAPSHOT_FORMAT_VERSION = 1 as const;
export type ProjectSnapshotFormatVersion = typeof PROJECT_SNAPSHOT_FORMAT_VERSION;

const BASE64_ENCODING_CHUNK_BYTES = 0x8000;
const LEGACY_CODEBASE_SOURCE_KIND = 'codebase-bundle';
const LEGACY_AGGREGATE_RECOVERY_NAME = 'Contenuto aggregato legacy - origini non disponibili.txt';
const OBSOLETE_LEGACY_FIELDS = new Set(['activeLaboratoryExerciseId', 'laboratory']);
const PROJECT_SOURCE_KINDS = new Set<ProjectSourceKind>([
  'document',
  'codebase',
  'learn-mode',
  'imported-json',
]);
const PROJECT_FIELDS = new Set([
  'activeSectionId',
  'createdAt',
  'documentAssets',
  'documentIndex',
  'extensions',
  'file',
  'id',
  'isLearnMode',
  'lastCourseGenerationRunId',
  'lastOpenedAt',
  'legacyUnmappedFields',
  'learningPlan',
  'musicUrl',
  'projectFormatVersion',
  'researchCoursePlan',
  'researchDossiersBySectionId',
  'source',
  'sourceKind',
  'state',
  'syllabus',
  'title',
  'updatedAt',
  'userProfile',
  'version',
]);
const PROJECT_CONTENT_FIELDS = new Set([
  'activeSectionId',
  'documentAssets',
  'documentIndex',
  'isLearnMode',
  'lastCourseGenerationRunId',
  'learningPlan',
  'researchCoursePlan',
  'researchDossiersBySectionId',
  'source',
  'sourceKind',
  'state',
  'syllabus',
  'title',
  'userProfile',
]);
const CANONICAL_REQUIRED_FIELDS = [
  'activeSectionId',
  'createdAt',
  'id',
  'isLearnMode',
  'lastOpenedAt',
  'learningPlan',
  'source',
  'sourceKind',
  'state',
  'syllabus',
  'updatedAt',
  'userProfile',
  'version',
] as const;
const STRING_FIELDS = [
  'createdAt',
  'id',
  'lastOpenedAt',
  'musicUrl',
  'state',
  'title',
  'updatedAt',
  'version',
] as const;
const NULLABLE_STRING_FIELDS = ['activeSectionId', 'lastCourseGenerationRunId'] as const;
const NULLABLE_RECORD_FIELDS = [
  'learningPlan',
  'researchCoursePlan',
  'source',
  'userProfile',
] as const;

export interface ProjectSnapshotWire {
  activeSectionId: string | null;
  createdAt: string;
  documentAssets?: unknown;
  documentIndex?: unknown;
  extensions?: Record<string, unknown>;
  id: string;
  isLearnMode: boolean;
  lastCourseGenerationRunId?: string | null;
  lastOpenedAt: string;
  legacyUnmappedFields?: Record<string, unknown>;
  learningPlan: Record<string, unknown> | null;
  musicUrl?: string;
  projectFormatVersion: ProjectSnapshotFormatVersion;
  researchCoursePlan?: Record<string, unknown> | null;
  researchDossiersBySectionId?: Record<string, unknown>;
  source: Record<string, unknown> | null;
  sourceKind: ProjectSourceKind;
  state: string;
  syllabus: unknown[];
  title?: string;
  updatedAt: string;
  userProfile: Record<string, unknown> | null;
  version: string;
}

export type LegacyProjectSnapshotWire = Partial<
  Omit<ProjectSnapshotWire, 'projectFormatVersion'>
> & {
  projectFormatVersion?: never;
};

export type DecodedProjectSnapshotWire = ProjectSnapshotWire | LegacyProjectSnapshotWire;

export interface ProjectSnapshotWireDecodeOptions {
  externalArchiveBytesAvailable?: boolean;
}

export class ProjectSnapshotWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectSnapshotWireError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalizeLessonContentBlocks = (contentBlocks: unknown[]): Record<string, unknown>[] =>
  contentBlocks.map(block => {
    if (!isRecord(block)) {
      throw new ProjectSnapshotWireError('Blocco contenuto lezione non valido.');
    }
    if (typeof block.type === 'string') {
      if (block.type === LESSON_MARKDOWN_BLOCK_TYPE && typeof block.markdown !== 'string') {
        throw new ProjectSnapshotWireError('Blocco Markdown lezione non valido.');
      }
      return block;
    }
    if (block.kind === LESSON_MARKDOWN_BLOCK_TYPE && typeof block.markdown === 'string') {
      const { kind: _legacyKind, ...canonicalBlock } = block;
      return { ...canonicalBlock, type: LESSON_MARKDOWN_BLOCK_TYPE };
    }
    throw new ProjectSnapshotWireError('Blocco contenuto lezione non valido.');
  });

export const canonicalizeLessonNodeContent = <Node extends Record<string, unknown>>(
  node: Node
): Node => {
  if (!Array.isArray(node.contentBlocks)) return node;
  const contentBlocks = canonicalizeLessonContentBlocks(node.contentBlocks);
  return {
    ...node,
    content: deriveLegacyLessonContent(contentBlocks),
    contentBlocks,
  } as Node;
};

const assertOptionalString = (record: Record<string, unknown>, key: string): void => {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    throw new ProjectSnapshotWireError(`Campo progetto non valido: ${key}.`);
  }
};

const assertOptionalRecord = (
  record: Record<string, unknown>,
  key: string,
  nullable = false
): void => {
  const value = record[key];
  if (value !== undefined && !(nullable && value === null) && !isRecord(value)) {
    throw new ProjectSnapshotWireError(`Campo progetto non valido: ${key}.`);
  }
};

const encodeTextBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_ENCODING_CHUNK_BYTES) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + BASE64_ENCODING_CHUNK_BYTES));
  }
  return globalThis.btoa(binary);
};

export const buildStableProjectSourceHash = (file: {
  data: string;
  mimeType: string;
  name: string;
}): string => {
  let hash = 0x811c9dc5;
  const value = `${file.name}\0${file.mimeType}\0${file.data}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const legacySourceMimeType = (path: string): string =>
  /\.(?:md|markdown|mdx)$/iu.test(path) ? 'text/markdown' : 'text/plain';

const migrateLegacyCodebaseSource = (source: Record<string, unknown>): Record<string, unknown> => {
  if (typeof source.name !== 'string' || !Array.isArray(source.files)) {
    throw new ProjectSnapshotWireError('Sorgente codebase-bundle non valida.');
  }

  const stats = isRecord(source.stats) ? source.stats : null;
  const sourceIsPartial =
    (typeof stats?.skippedFileCount === 'number' && stats.skippedFileCount > 0) ||
    (typeof stats?.truncatedFileCount === 'number' && stats.truncatedFileCount > 0);
  const occurrences = new Map<string, number>();
  const legacyFiles =
    source.files.length > 0
      ? source.files
      : typeof source.aggregatedText === 'string' && source.aggregatedText
        ? [
            {
              path: LEGACY_AGGREGATE_RECOVERY_NAME,
              text: source.aggregatedText,
              truncated: true,
            },
          ]
        : null;
  if (!legacyFiles) {
    throw new ProjectSnapshotWireError('Sorgente codebase-bundle senza contenuto recuperabile.');
  }
  const sources = legacyFiles.map((candidate, position) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== 'string' ||
      !candidate.path ||
      typeof candidate.text !== 'string' ||
      (candidate.truncated !== undefined && typeof candidate.truncated !== 'boolean')
    ) {
      throw new ProjectSnapshotWireError('File codebase-bundle non valido.');
    }
    const file = {
      data: encodeTextBase64(candidate.text),
      mimeType: legacySourceMimeType(candidate.path),
      name: candidate.path,
    };
    const hash = buildStableProjectSourceHash(file);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    const id = `source-${hash}-${occurrence}`;
    return {
      file: { ...file, sourceId: id },
      hash,
      id,
      kind: file.mimeType === 'text/markdown' ? 'markdown' : 'text',
      name: file.name,
      outline: [],
      outlineOrigin: 'none',
      position,
      status: candidate.truncated || sourceIsPartial ? 'partial' : 'ready',
    };
  });
  const primary = sources[0];
  if (!primary) {
    throw new ProjectSnapshotWireError('Sorgente codebase-bundle senza file.');
  }

  // When original files exist, aggregate/stat fields are derived duplicates. Aggregate-only
  // backups are recovered above under an explicit unknown-origin name instead.
  return { file: primary.file, kind: 'document', sources };
};

const migrateLegacyRootFile = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    typeof value.data !== 'string'
  ) {
    throw new ProjectSnapshotWireError('File sorgente legacy non valido.');
  }
  return {
    file: structuredClone(value),
    kind: value.mimeType === 'application/pdf' ? 'pdf' : 'document',
  };
};

const hasNonEmptyString = (record: Record<string, unknown>, key: string): boolean =>
  typeof record[key] === 'string' && Boolean(record[key]);

const readRecordArray = (value: unknown, errorMessage: string): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.some(entry => !isRecord(entry))) {
    throw new ProjectSnapshotWireError(errorMessage);
  }
  return value;
};

const isValidSourceRef = (value: unknown): boolean =>
  isRecord(value) &&
  hasNonEmptyString(value, 'id') &&
  hasNonEmptyString(value, 'hash') &&
  Number.isSafeInteger(value.byteSize) &&
  (value.byteSize as number) >= 0 &&
  hasNonEmptyString(value, 'name') &&
  hasNonEmptyString(value, 'mimeType') &&
  hasNonEmptyString(value, 'objectPath');

const readValidSourceFile = (
  value: unknown,
  ref: unknown,
  errorMessage: string,
  requireAvailableBytes = true
): Record<string, unknown> => {
  if (
    !isRecord(value) ||
    !hasNonEmptyString(value, 'name') ||
    !hasNonEmptyString(value, 'mimeType') ||
    typeof value.data !== 'string' ||
    (requireAvailableBytes && !value.data && !isValidSourceRef(ref))
  ) {
    throw new ProjectSnapshotWireError(errorMessage);
  }
  return value;
};

const validateSourceDescriptors = (value: unknown): void => {
  if (value === undefined) return;
  const sources = readRecordArray(value, 'Sorgente progetto non valida: sources.');
  if (sources.length === 0) {
    throw new ProjectSnapshotWireError('Sorgente progetto non valida: sources.');
  }
  for (const source of sources) {
    if (
      !hasNonEmptyString(source, 'id') ||
      !hasNonEmptyString(source, 'hash') ||
      !hasNonEmptyString(source, 'name') ||
      (source.kind !== 'markdown' && source.kind !== 'pdf' && source.kind !== 'text') ||
      !Array.isArray(source.outline) ||
      source.outline.some(node => !isRecord(node)) ||
      (source.outlineOrigin !== 'deterministic' &&
        source.outlineOrigin !== 'native' &&
        source.outlineOrigin !== 'none') ||
      !Number.isSafeInteger(source.position) ||
      (source.position as number) < 0 ||
      (source.status !== 'error' && source.status !== 'partial' && source.status !== 'ready') ||
      (source.ref !== undefined && !isValidSourceRef(source.ref))
    ) {
      throw new ProjectSnapshotWireError('Descrittore sorgente non valido.');
    }
    readValidSourceFile(source.file, source.ref, 'Descrittore sorgente non valido: file.');
  }
};

const hasPrimarySourceDescriptor = (
  source: Record<string, unknown>,
  file: Record<string, unknown>
): boolean => {
  if (!hasNonEmptyString(file, 'sourceId') || !Array.isArray(source.sources)) {
    return false;
  }
  return source.sources.some(
    descriptor =>
      isRecord(descriptor) &&
      descriptor.id === file.sourceId &&
      isRecord(descriptor.file) &&
      descriptor.file.sourceId === file.sourceId
  );
};

const validateArchiveIndex = (value: unknown): void => {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new ProjectSnapshotWireError('Sorgente archivio non valida: index.');
  }
  for (const entry of value.entries) {
    if (!isRecord(entry) || !hasNonEmptyString(entry, 'path')) {
      throw new ProjectSnapshotWireError('Sorgente archivio non valida: entry.');
    }
    if (entry.kind === 'directory') continue;
    if (
      entry.kind !== 'file' ||
      !Number.isSafeInteger(entry.byteSize) ||
      (entry.byteSize as number) < 0 ||
      (entry.contentKind !== 'binary' && entry.contentKind !== 'text') ||
      (entry.warningReason !== undefined && !isSourceArchivePdfWarningReason(entry.warningReason))
    ) {
      throw new ProjectSnapshotWireError('Sorgente archivio non valida: entry.');
    }
  }
};

const validateCanonicalSource = (
  source: Record<string, unknown>,
  options: ProjectSnapshotWireDecodeOptions
): void => {
  validateSourceDescriptors(source.sources);
  const sourceFile = isRecord(source.file) ? source.file : {};
  const file = readValidSourceFile(
    source.file,
    source.ref,
    'Sorgente progetto non valida: file.',
    source.kind === 'archive'
      ? !options.externalArchiveBytesAvailable
      : !hasPrimarySourceDescriptor(source, sourceFile)
  );
  if (source.kind === 'pdf' && file.mimeType !== 'application/pdf') {
    throw new ProjectSnapshotWireError('Sorgente PDF non valida: mimeType.');
  }
  if (source.kind === 'document' && file.mimeType === 'application/pdf') {
    throw new ProjectSnapshotWireError('Sorgente documento non valida: mimeType.');
  }
  if (source.kind === 'archive') {
    if (!hasNonEmptyString(source, 'name')) {
      throw new ProjectSnapshotWireError('Sorgente archivio non valida: name.');
    }
    validateArchiveIndex(source.index);
  }
};

const readCanonicalSource = (
  sourceValue: unknown,
  legacyFile: unknown,
  options: ProjectSnapshotWireDecodeOptions
): { source?: Record<string, unknown> | null; sourceKind?: ProjectSourceKind } => {
  const source = sourceValue === undefined ? migrateLegacyRootFile(legacyFile) : sourceValue;
  if (source === undefined) return {};
  if (source === null) return { source: null };
  if (!isRecord(source) || typeof source.kind !== 'string') {
    throw new ProjectSnapshotWireError('Sorgente progetto non valida.');
  }
  if (source.kind === LEGACY_CODEBASE_SOURCE_KIND) {
    return { source: migrateLegacyCodebaseSource(source), sourceKind: 'codebase' };
  }
  if (source.kind !== 'archive' && source.kind !== 'document' && source.kind !== 'pdf') {
    throw new ProjectSnapshotWireError(`Tipo sorgente progetto non supportato: ${source.kind}.`);
  }
  validateCanonicalSource(source, options);
  return {
    source: structuredClone(source),
    ...(source.kind === 'archive' ? { sourceKind: 'codebase' as const } : {}),
  };
};

const readExtensions = (record: Record<string, unknown>): Record<string, unknown> | undefined => {
  assertOptionalRecord(record, 'extensions');
  return isRecord(record.extensions) && Object.keys(record.extensions).length > 0
    ? structuredClone(record.extensions)
    : undefined;
};

const readLegacyUnmappedFields = (
  record: Record<string, unknown>,
  isLegacy: boolean
): Record<string, unknown> | undefined => {
  assertOptionalRecord(record, 'legacyUnmappedFields');
  const explicitlyQuarantined = isRecord(record.legacyUnmappedFields)
    ? structuredClone(record.legacyUnmappedFields)
    : {};
  const unknownEntries = Object.entries(record).filter(
    ([key]) => !PROJECT_FIELDS.has(key) && !(isLegacy && OBSOLETE_LEGACY_FIELDS.has(key))
  );
  if (!isLegacy && unknownEntries.length > 0) {
    throw new ProjectSnapshotWireError(
      `Campo progetto non supportato: ${unknownEntries[0]?.[0] ?? 'sconosciuto'}.`
    );
  }
  const migratedEntries = unknownEntries.map(([key, value]) => {
    if (Object.hasOwn(explicitlyQuarantined, key)) {
      throw new ProjectSnapshotWireError(`Campo legacy duplicato: ${key}.`);
    }
    return [key, structuredClone(value)] as const;
  });
  const quarantined = Object.fromEntries([
    ...Object.entries(explicitlyQuarantined),
    ...migratedEntries,
  ]);
  return Object.keys(quarantined).length > 0 ? quarantined : undefined;
};

const validateLearningPlan = (value: Record<string, unknown>): void => {
  if (value.modules === undefined && value.sections === undefined) {
    throw new ProjectSnapshotWireError('Piano didattico non valido: struttura mancante.');
  }
  if (value.modules !== undefined) {
    const modules = readRecordArray(value.modules, 'Piano didattico non valido: modules.');
    for (const module of modules) {
      if (!hasNonEmptyString(module, 'id') || !hasNonEmptyString(module, 'title')) {
        throw new ProjectSnapshotWireError('Piano didattico non valido: modulo senza identità.');
      }
      const children = readRecordArray(module.children, 'Piano didattico non valido: children.');
      for (const child of children) {
        if (
          !hasNonEmptyString(child, 'id') ||
          !hasNonEmptyString(child, 'title') ||
          (child.kind !== 'lesson' && child.kind !== 'exercise')
        ) {
          throw new ProjectSnapshotWireError(
            'Piano didattico non valido: nodo senza identità o tipo.'
          );
        }
      }
    }
  }
  if (value.sections !== undefined) {
    readRecordArray(value.sections, 'Piano didattico non valido: sections.');
  }
};

const canonicalizeLearningPlanContent = (
  learningPlan: Record<string, unknown>
): Record<string, unknown> => ({
  ...learningPlan,
  ...(Array.isArray(learningPlan.modules)
    ? {
        modules: learningPlan.modules.map(module => {
          if (!isRecord(module) || !Array.isArray(module.children)) return module;
          return {
            ...module,
            children: module.children.map(child =>
              isRecord(child) && child.kind === 'lesson'
                ? canonicalizeLessonNodeContent(child)
                : child
            ),
          };
        }),
      }
    : {}),
  ...(Array.isArray(learningPlan.sections)
    ? {
        sections: learningPlan.sections.map(section =>
          isRecord(section) ? canonicalizeLessonNodeContent(section) : section
        ),
      }
    : {}),
});

const validateProjectFields = (record: Record<string, unknown>): void => {
  STRING_FIELDS.forEach(key => {
    assertOptionalString(record, key);
  });
  NULLABLE_STRING_FIELDS.forEach(key => {
    if (record[key] !== null) assertOptionalString(record, key);
  });
  NULLABLE_RECORD_FIELDS.forEach(key => {
    assertOptionalRecord(record, key, true);
  });
  assertOptionalRecord(record, 'researchDossiersBySectionId');
  if (record.isLearnMode !== undefined && typeof record.isLearnMode !== 'boolean') {
    throw new ProjectSnapshotWireError('Campo progetto non valido: isLearnMode.');
  }
  if (record.syllabus !== undefined && !Array.isArray(record.syllabus)) {
    throw new ProjectSnapshotWireError('Campo progetto non valido: syllabus.');
  }
  if (
    record.sourceKind !== undefined &&
    (typeof record.sourceKind !== 'string' ||
      !PROJECT_SOURCE_KINDS.has(record.sourceKind as ProjectSourceKind))
  ) {
    throw new ProjectSnapshotWireError('Campo progetto non valido: sourceKind.');
  }
  if (isRecord(record.learningPlan)) {
    validateLearningPlan(record.learningPlan);
  }
};

const findMissingCanonicalProjectField = (
  record: Record<string, unknown>
): (typeof CANONICAL_REQUIRED_FIELDS)[number] | undefined =>
  CANONICAL_REQUIRED_FIELDS.find(key => !Object.hasOwn(record, key) || record[key] === undefined);

type CanonicalProjectSnapshotCore = Omit<ProjectSnapshotWire, 'projectFormatVersion'>;

function assertCompleteCanonicalProject(
  record: Record<string, unknown>
): asserts record is CanonicalProjectSnapshotCore {
  const missingField = findMissingCanonicalProjectField(record);
  if (missingField) {
    throw new ProjectSnapshotWireError(`Snapshot canonico incompleto: ${missingField}.`);
  }
}

const hasMeaningfulProjectValue = (value: unknown): boolean => {
  if (typeof value === 'string') return Boolean(value);
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value);
};

export const decodeProjectSnapshotWire = (
  value: unknown,
  options: ProjectSnapshotWireDecodeOptions = {}
): DecodedProjectSnapshotWire => {
  if (!isRecord(value)) {
    throw new ProjectSnapshotWireError('Snapshot progetto non valido.');
  }
  const isLegacy = value.projectFormatVersion === undefined;
  if (!isLegacy && value.projectFormatVersion !== PROJECT_SNAPSHOT_FORMAT_VERSION) {
    throw new ProjectSnapshotWireError(
      `Versione formato progetto non supportata: ${String(value.projectFormatVersion)}.`
    );
  }
  if (
    !isLegacy &&
    (value.file !== undefined ||
      (isRecord(value.source) && value.source.kind === LEGACY_CODEBASE_SOURCE_KIND))
  ) {
    throw new ProjectSnapshotWireError('Snapshot canonico con campi sorgente legacy.');
  }
  const extensions = readExtensions(value);
  const legacyUnmappedFields = readLegacyUnmappedFields(value, isLegacy);
  const legacyFile = value.file;
  if (!isLegacy) assertCompleteCanonicalProject(value);
  const hasProjectIdentity =
    (typeof value.id === 'string' && Boolean(value.id)) ||
    (typeof value.version === 'string' && Boolean(value.version)) ||
    isRecord(value.source);
  const hasProjectContent = Object.entries(value).some(
    ([key, entry]) => PROJECT_CONTENT_FIELDS.has(key) && hasMeaningfulProjectValue(entry)
  );
  if (!hasProjectIdentity || !hasProjectContent) {
    throw new ProjectSnapshotWireError('Snapshot progetto vuoto.');
  }
  validateProjectFields(value);
  const canonicalSource = readCanonicalSource(value.source, legacyFile, options);
  const project = Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => PROJECT_FIELDS.has(key) && key !== 'file' && entry !== undefined)
      .map(([key, entry]) => [key, structuredClone(entry)])
  ) as LegacyProjectSnapshotWire;
  const learningPlan = isRecord(project.learningPlan)
    ? canonicalizeLearningPlanContent(project.learningPlan)
    : project.learningPlan;

  const decoded = {
    ...project,
    ...(learningPlan === undefined ? {} : { learningPlan }),
    ...canonicalSource,
    ...(canonicalSource.sourceKind
      ? { sourceKind: canonicalSource.sourceKind }
      : project.sourceKind
        ? { sourceKind: project.sourceKind }
        : {}),
    ...(extensions ? { extensions } : {}),
    ...(legacyUnmappedFields ? { legacyUnmappedFields } : {}),
  };
  if (!isLegacy || findMissingCanonicalProjectField(decoded) === undefined) {
    assertCompleteCanonicalProject(decoded);
    return { ...decoded, projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION };
  }
  return decoded;
};

export const encodeProjectSnapshotWire = (
  value: unknown,
  options: ProjectSnapshotWireDecodeOptions = {}
): ProjectSnapshotWire => {
  if (!isRecord(value)) {
    throw new ProjectSnapshotWireError('Snapshot progetto non valido.');
  }
  const decoded = decodeProjectSnapshotWire(
    {
      ...value,
      projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
    },
    options
  );
  if (decoded.projectFormatVersion !== PROJECT_SNAPSHOT_FORMAT_VERSION) {
    throw new ProjectSnapshotWireError('Codifica progetto canonico non riuscita.');
  }
  return decoded;
};
