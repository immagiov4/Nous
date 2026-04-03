import type { ProjectSnapshot, WorkspaceDomainState } from '../../types';

export const buildPersistenceSignature = (
  snapshotLike:
    | Pick<
        ProjectSnapshot,
        | 'source'
        | 'learningPlan'
        | 'documentAssets'
        | 'documentIndex'
        | 'isLearnMode'
        | 'userProfile'
        | 'syllabus'
        | 'activeSectionId'
      >
    | WorkspaceDomainState
): string =>
  JSON.stringify({
    source: snapshotLike.source,
    learningPlan: snapshotLike.learningPlan,
    documentAssets: snapshotLike.documentAssets ?? null,
    documentIndex: snapshotLike.documentIndex ?? null,
    isLearnMode: snapshotLike.isLearnMode,
    userProfile: snapshotLike.userProfile,
    syllabus: snapshotLike.syllabus,
    activeSectionId: snapshotLike.activeSectionId,
  });
