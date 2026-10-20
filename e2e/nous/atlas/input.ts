import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readLibraryArchive } from '../../../apps/web/services/projects/libraryArchive';
import {
  inspectProjectArchiveData,
  PROJECT_ARCHIVE_LIMITS,
  readLegacyProjectImportData,
} from '../../../apps/web/services/projects/projectArchive';
import { normalizeStoredProject } from '../../../apps/web/services/projects/projectSnapshot';
import type { LessonNode, PdfDocumentImageAsset, ProjectSnapshot } from '../../../apps/web/types';
import { flattenLessons } from '../../../apps/web/utils/learning/pathNodes';
import { buildLessonAssetMap } from '../../../apps/web/utils/reader/workspaceReader';
import {
  decodeProjectBackupArchive,
  type ProjectBackupAssetInput,
} from '../../../packages/shared-types/projectBackupArchive';
import { decodeProjectSnapshotWire } from '../../../packages/shared-types/projectSnapshotWire';
import { syntheticCourse } from '../syntheticCourse';
import type { AtlasScenario } from './scenario';
import { syntheticPairwiseCourse } from './synthetic';

export interface AtlasCourse {
  snapshot: ProjectSnapshot;
  assets: readonly ProjectBackupAssetInput[];
}
export interface AtlasLesson {
  projectId: string;
  courseTitle: string;
  id: string;
  title: string;
  content: string;
  sources: NonNullable<LessonNode['contentBlocks']>;
  visuals: NonNullable<LessonNode['generatedVisuals']>;
  imageRefs: NonNullable<LessonNode['imageRefs']>;
  images: Record<string, PdfDocumentImageAsset>;
}

export function atlasLessons(snapshot: ProjectSnapshot): AtlasLesson[] {
  return flattenLessons(snapshot.learningPlan?.modules).map(lesson => ({
    projectId: snapshot.id,
    courseTitle: snapshot.title ?? snapshot.learningPlan?.title ?? snapshot.id,
    id: lesson.id,
    title: lesson.title,
    content: lesson.content ?? '',
    sources: lesson.contentBlocks ?? [
      { type: 'markdown' as const, markdown: lesson.content ?? '' },
    ],
    visuals: lesson.generatedVisuals ?? [],
    imageRefs: lesson.imageRefs ?? [],
    images: buildLessonAssetMap(lesson.imageRefs, snapshot.documentAssets ?? null),
  }));
}

/** Product archive readers validate and hydrate attachments; input files remain read-only. */
export async function* atlasCourses(
  input: AtlasScenario['fixture'],
  courseId?: string
): AsyncGenerator<AtlasCourse> {
  if (input.kind === 'library') {
    if (process.env.CI) throw new Error('Private library atlases are local-only.');
    const library = await readLibraryArchive(new Blob([await readFile(input.path)]));
    if (library.rejectedProjects.length)
      throw new Error('Library contains rejected course archives.');
    for (const entry of library.projectArchives.filter(
      entry => !courseId || entry.id === courseId
    )) {
      const decoded = await decodeProjectBackupArchive(
        new Uint8Array(await entry.archive.arrayBuffer()),
        PROJECT_ARCHIVE_LIMITS
      );
      yield { snapshot: normalizeStoredProject(decoded.project), assets: decoded.assets };
    }
    return;
  }
  if (input.kind === 'project') {
    const bytes = await readFile(input.path);
    if (input.path.endsWith('.zip')) {
      const snapshot = await inspectProjectArchiveData(new Blob([bytes]));
      const decoded = await decodeProjectBackupArchive(
        new Uint8Array(bytes),
        PROJECT_ARCHIVE_LIMITS
      );
      yield { snapshot: normalizeStoredProject(snapshot), assets: decoded.assets };
    } else {
      yield {
        snapshot: normalizeStoredProject(await readLegacyProjectImportData(new Blob([bytes]))),
        assets: [],
      };
    }
    return;
  }
  yield {
    snapshot: normalizeStoredProject(
      decodeProjectSnapshotWire(
        input.generator === 'pairwise'
          ? syntheticPairwiseCourse(
              'data:image/png;base64,' +
                (
                  await readFile(
                    fileURLToPath(
                      new URL(
                        '../../../packages/playtest/tests/fixtures/images/first.png',
                        import.meta.url
                      )
                    )
                  )
                ).toString('base64')
            )
          : syntheticCourse(input.generator)
      )
    ),
    assets: [],
  };
}
