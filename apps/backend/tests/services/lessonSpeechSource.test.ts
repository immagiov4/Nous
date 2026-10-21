import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), load: vi.fn() }));
vi.mock('../../src/services/lessonEvidence.js', () => ({
  readStoredTranscribedSources: mocks.read,
}));
vi.mock('../../src/projects/projectStore.js', () => ({
  getProjectStore: () => ({ loadProjectWithRevision: mocks.load }),
}));

import { readLessonPlayback } from '../../src/projects/lessonPlayback.js';
import {
  readLessonSpeechProvenance,
  resolveLessonSpeechSource,
} from '../../src/services/lessonSpeechSource.js';
import {
  LessonPlaybackStaleError,
  LessonPlaybackTargetError,
} from '../../src/workflows/lessonPlaybackApi.js';
import { playbackProject, playbackSection } from '../helpers/lessonPlayback.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockReturnValue([]);
});
test('retains identified transcription metadata and reports unreadable optional evidence', () => {
  const project = playbackProject();
  project.researchDossiersBySectionId = { 'section-1': { evidencePacketJson: 'stored-evidence' } };
  const sources = [{ title: 'Synthetic notes', transcribedPages: [7] }];
  mocks.read.mockReturnValue(sources);
  expect(readLessonSpeechProvenance(project, 'section-1')).toEqual({
    kind: 'vision-transcription',
    sources,
  });
  expect(mocks.read).toHaveBeenCalledWith('stored-evidence');
  mocks.read.mockReturnValue([]);
  expect(readLessonSpeechProvenance(project, 'section-1')).toBeUndefined();
  mocks.read.mockImplementation(() => {
    throw new Error('Invalid archive');
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(readLessonSpeechProvenance(project, 'section-1')).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});

test('selects the current owner and exact source, preserving saved preparation', async () => {
  const section = playbackSection();
  const raw = readLessonPlayback(section);
  const prepared = { motion: [] };
  section.playback = { ...raw, blocks: raw.blocks.map(block => ({ ...block, prepared })) };
  const project = playbackProject(section);
  mocks.load.mockResolvedValue({ snapshot: project });
  const input = {
    userId: 'one',
    target: { projectId: project.id, sectionId: section.id as string },
    block: raw.blocks[0],
  };
  expect((await resolveLessonSpeechSource(input)).block.prepared).toBe(prepared);
  expect(mocks.load).toHaveBeenCalledWith('one', project.id);
  await expect(
    resolveLessonSpeechSource({ ...input, block: { ...input.block, speech: 'Changed text.' } })
  ).rejects.toBeInstanceOf(LessonPlaybackStaleError);
  mocks.load.mockResolvedValue(null);
  await expect(resolveLessonSpeechSource(input)).rejects.toBeInstanceOf(LessonPlaybackTargetError);
});
