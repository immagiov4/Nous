import { type LessonPlaybackBlock, segmentLessonPlayback } from '@shared/lessonPlayback';
import { readLessonPlayback } from '../projects/lessonPlayback.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectSnapshot } from '../projects/types.js';
import {
  LessonPlaybackStaleError,
  LessonPlaybackTargetError,
} from '../workflows/lessonPlaybackApi.js';
import { readStoredTranscribedSources } from './lessonEvidence.js';
import { readExistingDossier } from './lessonGenerationSources.js';
import type { LessonSourceProvenance } from './lessonPrimarySourceContext.js';

/** Retained source metadata is optional; malformed evidence cannot block an existing lesson. */
export const readLessonSpeechProvenance = (
  project: ProjectSnapshot,
  sectionId: string
): LessonSourceProvenance | undefined => {
  const dossier = readExistingDossier(project, sectionId);
  try {
    const sources = readStoredTranscribedSources(
      typeof dossier?.evidencePacketJson === 'string' ? dossier.evidencePacketJson : undefined
    );
    return sources.length ? { kind: 'vision-transcription', sources } : undefined;
  } catch {
    console.warn('[lesson-speech] Stored evidence is unreadable; omitting optional provenance.');
    return undefined;
  }
};

const speechIdentity = (block: LessonPlaybackBlock): string =>
  JSON.stringify([
    block.speech,
    block.spans.flatMap(span => (span.math ? [span.math] : [])),
    block.spans.flatMap(span => (span.fencedCode ? [span.fencedCode] : [])),
  ]);

/** Resolve only the current owner's lesson, preserving server-prepared narration. */
export const resolveLessonSpeechSource = async (input: {
  userId: string;
  block: LessonPlaybackBlock;
  target: { projectId: string; sectionId: string };
}) => {
  const { target } = input;
  const project = await getProjectStore().loadProjectWithRevision(input.userId, target.projectId);
  const section = project && findProjectLessonSection(project.snapshot, target.sectionId);
  if (!project || !section) throw new LessonPlaybackTargetError();
  const source = segmentLessonPlayback(
    Array.isArray(section.contentBlocks)
      ? section.contentBlocks
      : [{ type: 'markdown', markdown: typeof section.content === 'string' ? section.content : '' }]
  ).find(block => block.id === input.block.id);
  if (!source || speechIdentity(source) !== speechIdentity(input.block))
    throw new LessonPlaybackStaleError();
  const block = readLessonPlayback(section).blocks.find(block => block.id === source.id);
  if (!block) throw new Error('The stored speech block is missing.');
  return {
    block,
    sourceProvenance: readLessonSpeechProvenance(project.snapshot, target.sectionId),
  };
};
