import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PostgresProjectStore } from '../../apps/backend/src/projects/postgresProjectStore';
import { readLibraryArchive } from '../../apps/web/services/projects/libraryArchive';
import { normalizeStoredProject } from '../../apps/web/services/projects/projectSnapshot';
import { flattenLessons } from '../../apps/web/utils/learning/pathNodes';
import { isRecord } from '../../apps/web/utils/records';
import type { Story } from '../../packages/playtest/src/types';
import {
  inspectProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '../../packages/shared-types/projectBackupArchive';
import { decodeProjectSnapshotWire } from '../../packages/shared-types/projectSnapshotWire';
import { dataRoot, REPO_ROOT } from './stack';

type ImportStore = Pick<PostgresProjectStore, 'importProjectArchive' | 'importProject'>;
interface FixtureCourse {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string | null;
  readonly lessonCount: number;
  readonly appVersion: string | null;
  readonly projectFormatVersion: number | null;
  readonly archiveVersion: number;
}
export interface FixtureImport {
  readonly originalProjectId: string | null;
  readonly importedProjectId: string;
  readonly archivePath: string;
  readonly archiveBytes: number;
  readonly sha256: string;
  readonly courseId: string | null;
  readonly title: string;
  readonly updatedAt: string | null;
}

const projectArchiveLimits = {
  invalidArchiveMessage: 'Invalid course fixture archive.',
  maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
  maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
};

async function fixturePath(name: string): Promise<string> {
  const root = await realpath(join(dataRoot(), 'fixtures')).catch(cause => {
    throw new Error('Required fixture directory is missing or unreadable.', { cause });
  });
  const path = await realpath(resolve(root, name)).catch(error => {
    throw new Error(`Required fixture is missing: ${name}.`, { cause: error });
  });
  const within = relative(root, path);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error('Required fixture must be a file within NOUS_E2E_DATA/fixtures.');
  const repository = await realpath(REPO_ROOT);
  const fromRepo = relative(repository, path);
  if (!fromRepo || (!fromRepo.startsWith(`..${sep}`) && fromRepo !== '..' && !isAbsolute(fromRepo)))
    throw new Error('Fixture archives must be outside the repository.');
  if (!(await stat(path)).isFile()) throw new Error('Required fixture must be a file.');
  return path;
}

function libraryName(): string {
  return process.env.NOUS_E2E_LIBRARY ?? 'nous-library-backup.nous-library.zip';
}

async function fixtureFileExists(name: string): Promise<boolean> {
  try {
    return (await stat(resolve(dataRoot(), 'fixtures', name))).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A valid course title can exceed the filesystem's filename limit.
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return false;
    throw error;
  }
}

async function readInventory() {
  const archivePath = await fixturePath(libraryName());
  const memoryBefore = process.memoryUsage();
  const resourceBefore = process.resourceUsage();
  const started = performance.now();
  try {
    const bytes = await readFile(archivePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const library = await readLibraryArchive(new Blob([Uint8Array.from(bytes).buffer]));
    if (library.rejectedProjects.length) {
      const rejected = library.rejectedProjects
        .map(course => `${course.id} (${course.code})`)
        .join(', ');
      throw new Error(`Library fixture contains rejected courses: ${rejected}.`);
    }
    const courses: FixtureCourse[] = [];
    const archives = new Map<string, Blob>();
    for (const entry of library.projectArchives) {
      const inspected = await inspectProjectBackupArchive(
        new Uint8Array(await entry.archive.arrayBuffer()),
        projectArchiveLimits
      );
      if (!isRecord(inspected.project)) throw new Error('Validated course metadata is absent.');
      // Sources are externalized in the manifest; readLibraryArchive already validates their bytes.
      const snapshot = decodeProjectSnapshotWire({ ...inspected.project, source: null });
      courses.push(
        Object.freeze({
          id: entry.id,
          title: entry.title,
          updatedAt: snapshot.updatedAt ?? null,
          lessonCount: flattenLessons(normalizeStoredProject(snapshot).learningPlan?.modules)
            .length,
          appVersion: snapshot.version ?? null,
          projectFormatVersion:
            typeof inspected.project.projectFormatVersion === 'number'
              ? inspected.project.projectFormatVersion
              : null,
          archiveVersion: inspected.archiveVersion,
        })
      );
      archives.set(entry.id, entry.archive);
    }
    courses.sort((left, right) => (left.id < right.id ? -1 : Number(left.id > right.id)));
    const inventory = Object.freeze({
      archivePath,
      archiveBytes: bytes.byteLength,
      sha256,
      courses: Object.freeze(courses),
      decodeDurationMs: performance.now() - started,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      resourceBefore,
      resourceAfter: process.resourceUsage(),
    });
    return { inventory, archives };
  } catch (cause) {
    throw new Error(
      'Cannot decode library fixture. Check the configured backup and its supported archive format.',
      { cause }
    );
  }
}

async function importSingleFile(
  selection: string,
  store: ImportStore,
  userId: string,
  onImport?: (fixture: FixtureImport) => Promise<void>
): Promise<FixtureImport> {
  const archivePath = await fixturePath(selection);
  const bytes = await readFile(archivePath);
  const imported = selection.endsWith('.json')
    ? await store.importProject(userId, JSON.parse(bytes.toString('utf8')))
    : await store.importProjectArchive(userId, bytes, crypto.randomUUID());
  const original = selection.endsWith('.json')
    ? JSON.parse(bytes.toString('utf8'))
    : (await inspectProjectBackupArchive(bytes, projectArchiveLimits)).project;
  if (!isRecord(original)) throw new Error('Single-course fixture metadata is absent.');
  const originalId = typeof original.id === 'string' ? original.id : null;
  const fixture = Object.freeze({
    archivePath,
    archiveBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    originalProjectId: originalId,
    importedProjectId: imported.snapshot.id,
    courseId: originalId,
    title: imported.meta.title,
    updatedAt: typeof original.updatedAt === 'string' ? original.updatedAt : null,
  });
  await onImport?.(fixture);
  return fixture;
}

/** One run owns one decode promise; only immutable metadata and archive Blobs are shared. */
export class CourseFixtures {
  private library?: ReturnType<typeof readInventory>;
  constructor(
    private readonly onImport?: (
      fixture: FixtureImport,
      inventory?: Awaited<ReturnType<typeof readInventory>>['inventory']
    ) => Promise<void>
  ) {}
  private load() {
    this.library ??= readInventory();
    return this.library;
  }
  async inventory() {
    return (await this.load()).inventory;
  }
  /** Resolve existing files first; decode the library only for a course selection. */
  private async resolveSelection(selection: string) {
    if (!selection.trim()) throw new Error('A fixture course ID or exact title is required.');
    const fileSelection =
      (await fixtureFileExists(selection)) ||
      ((selection.endsWith('.json') || selection.endsWith('.zip')) &&
        !(await fixtureFileExists(libraryName())));
    if (fileSelection) return { kind: 'file' as const, filename: selection };
    const { inventory, archives } = await this.load();
    const matches = inventory.courses.filter(
      course => course.id === selection || course.title === selection
    );
    if (!matches.length)
      throw new Error(
        `Fixture course is missing: ${selection}. Use the fixture inventory to select an exact ID or title.`
      );
    if (matches.length !== 1)
      throw new Error(
        `Fixture course selection is ambiguous: ${selection}. Select a course ID from the inventory.`
      );
    const course = matches[0];
    const archive = archives.get(course.id);
    if (!archive) throw new Error('Selected fixture archive is absent after validation.');
    return { kind: 'library' as const, course, archive, inventory };
  }
  /** Import the resolved fixture through the product importer and record its provenance. */
  async importCourse(
    selection: string,
    store: ImportStore,
    userId: string
  ): Promise<FixtureImport> {
    const selected = await this.resolveSelection(selection);
    if (selected.kind === 'file')
      return importSingleFile(selected.filename, store, userId, this.onImport);
    const { course, archive, inventory } = selected;
    const imported = await store.importProjectArchive(
      userId,
      new Uint8Array(await archive.arrayBuffer()),
      crypto.randomUUID()
    );
    const fixture = Object.freeze({
      originalProjectId: course.id,
      importedProjectId: imported.snapshot.id,
      archivePath: inventory.archivePath,
      archiveBytes: inventory.archiveBytes,
      sha256: inventory.sha256,
      courseId: course.id,
      title: course.title,
      updatedAt: course.updatedAt,
    });
    await this.onImport?.(fixture, inventory);
    return fixture;
  }
}

const runs = new AsyncLocalStorage<CourseFixtures>();
/** Bind the shared fixture decode and optional provenance writer to this execution only. */
export function withFixtureRun<T>(
  action: () => Promise<T>,
  onImport?: (
    fixture: FixtureImport,
    inventory?: Awaited<ReturnType<typeof readInventory>>['inventory']
  ) => Promise<void>
): Promise<T> {
  return runs.run(new CourseFixtures(onImport), action);
}
export function importFixture(selection: string, store: ImportStore, userId: string) {
  return (runs.getStore() ?? new CourseFixtures()).importCourse(selection, store, userId);
}

if (import.meta.main) {
  if (process.argv[2] !== '--inventory')
    throw new Error('Use --inventory to list library fixture courses.');
  console.log(JSON.stringify(await new CourseFixtures().inventory(), null, 2));
}

/** Private fixtures require explicit local consent, including environment overrides. */
export async function privateFixtureSkipReason(
  story: Pick<Story, 'requires'>
): Promise<string | undefined> {
  const course =
    story.requires.course === undefined
      ? undefined
      : (process.env.NOUS_E2E_COURSE ?? story.requires.course);
  if (typeof course !== 'string' || !course.startsWith('fixture:')) return;
  if (process.env.CI) return 'Private course fixtures never run in CI.';
  if (process.env.NOUS_E2E_PRIVATE_FIXTURES !== '1')
    return 'Private course fixtures require NOUS_E2E_PRIVATE_FIXTURES=1.';
  if (!process.env.NOUS_E2E_DATA)
    return 'Private course fixtures are unavailable: NOUS_E2E_DATA is unset.';
  const selection = course.slice('fixture:'.length);
  if (!(await fixtureFileExists(selection)) && !(await fixtureFileExists(libraryName())))
    return 'Private course fixture backup is unavailable.';
}
