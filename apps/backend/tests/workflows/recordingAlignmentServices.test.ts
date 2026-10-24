import { resolvePlaybackNarration } from '@shared/lessonPlayback';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectAssetReader } from '../../src/projects/projectAssetReader.js';
import { createProductionRecordingAlignmentServices } from '../../src/workflows/recordingAlignment.js';
import {
  playbackProject,
  playbackResult,
  playbackSection,
  preparedPlayback,
} from '../helpers/lessonPlayback.js';

const mocks = vi.hoisted(() => ({ load: vi.fn(), align: vi.fn() }));
vi.mock('../../src/projects/projectStore.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/projects/projectStore.js')>()),
  getProjectStore: () => ({ loadProjectWithRevision: mocks.load }),
}));
vi.mock('../../src/services/lessonPlayback/alignRecording.js', () => ({
  alignRecording: mocks.align,
}));

beforeEach(() => {
  mocks.load.mockReset();
  mocks.align.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const section = playbackSection();
  section.playback = preparedPlayback(section);
  const { target: original, block } = playbackResult(section);
  const target = { ...original, assetId: block.audio[0].asset.id };
  const project = {
    snapshot: playbackProject(section),
    revision: 1,
    incarnationId: target.incarnationId,
  };
  project.snapshot.userProfile = { language: 'English' };
  mocks.load.mockResolvedValue(project);
  const alignment = { status: 'aligned' as const, onsets: [0.1, 0.8] };
  mocks.align.mockResolvedValue(alignment);
  const readActive = vi
    .fn<ProjectAssetReader['readActive']>()
    .mockResolvedValue({ bytes: new Uint8Array([73, 68, 51]), mediaType: 'audio/mpeg' });
  const services = createProductionRecordingAlignmentServices({ readActive });
  const controller = new AbortController();
  const run = (input = target) =>
    services.alignPlaybackRecording({ input, signal: controller.signal } as Parameters<
      typeof services.alignPlaybackRecording
    >[0]);
  return { section, block, target, project, alignment, readActive, controller, run };
}

test('aligns the authorized stored recording against its canonical narration', async () => {
  const f = fixture();
  await expect(f.run()).resolves.toEqual({
    target: f.target,
    speech: resolvePlaybackNarration(f.block).speech,
    alignment: f.alignment,
  });
  expect(mocks.load).toHaveBeenCalledWith(f.target.userId, f.target.projectId);
  expect(f.readActive).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: f.target.userId,
      projectId: f.target.projectId,
      assetId: f.target.assetId,
    })
  );
  expect(mocks.align).toHaveBeenCalledWith({
    bytes: new Uint8Array([73, 68, 51]),
    mediaType: 'audio/mpeg',
    speech: resolvePlaybackNarration(f.block).speech,
    durationSeconds: 2,
    language: 'English',
    signal: f.controller.signal,
  });
});

test.each([
  'incarnationId',
  'lessonKey',
  'blockId',
  'sectionId',
  'assetId',
] as const)('discards obsolete recording work after %s changes', async field => {
  const f = fixture();
  const result = await f.run({ ...f.target, [field]: 'replaced' });
  expect(result.alignment).toBeNull();
  expect(f.readActive).not.toHaveBeenCalled();
  expect(mocks.align).not.toHaveBeenCalled();
});

test('discards work after the project is removed', async () => {
  const f = fixture();
  mocks.load.mockResolvedValue(null);
  await expect(f.run()).resolves.toEqual({ target: f.target, speech: '', alignment: null });
  expect(f.readActive).not.toHaveBeenCalled();
});

test('retains a recorded failed alignment without repeating the computation', async () => {
  const f = fixture();
  if (!f.section.playback) throw new Error('Prepared fixture must have playback');
  f.section.playback.blocks[0].audio[0].wordAlignment = { status: 'failed' };
  expect((await f.run()).alignment).toBeNull();
  expect(f.readActive).not.toHaveBeenCalled();
  expect(mocks.align).not.toHaveBeenCalled();
});

test.each([
  'missing asset',
  'alignment failure',
])('keeps narration usable after %s', async cause => {
  const f = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  if (cause === 'missing asset') f.readActive.mockResolvedValue(null);
  else mocks.align.mockRejectedValue(new Error('Synthetic alignment failure'));
  await expect(f.run()).resolves.toEqual({
    target: f.target,
    speech: resolvePlaybackNarration(f.block).speech,
    alignment: { status: 'failed' },
  });
  expect(warning).toHaveBeenCalledWith(
    '[recording-alignment] Keeping estimated word timing.',
    expect.any(Error)
  );
});

test('propagates cancellation instead of saving a failed alignment', async () => {
  const f = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const reason = new Error('Recording selection replaced');
  mocks.align.mockImplementation(async () => {
    f.controller.abort(reason);
    throw new Error('Child cancelled');
  });
  await expect(f.run()).rejects.toBe(reason);
  expect(warning).not.toHaveBeenCalled();
});
