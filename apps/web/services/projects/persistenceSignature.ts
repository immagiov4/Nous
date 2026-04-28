import type { ProjectSnapshot, WorkspaceDomainState } from '../../types';

const objectSignatureCache = new WeakMap<object, string>();

const buildSignaturePart = <T>(value: T): T | string => {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const cachedSignature = objectSignatureCache.get(value);
  if (cachedSignature) {
    return cachedSignature;
  }

  const signature = JSON.stringify(value);
  objectSignatureCache.set(value, signature);
  return signature;
};

export const buildPersistenceSignature = (
  snapshotLike:
    | Pick<
        ProjectSnapshot,
        | 'source'
        | 'learningPlan'
        | 'laboratory'
        | 'documentAssets'
        | 'documentIndex'
        | 'isLearnMode'
        | 'userProfile'
        | 'syllabus'
        | 'activeSectionId'
        | 'activeLaboratoryExerciseId'
      >
    | WorkspaceDomainState
): string =>
  JSON.stringify({
    source: buildSignaturePart(snapshotLike.source),
    learningPlan: buildSignaturePart(snapshotLike.learningPlan),
    laboratory: buildSignaturePart(snapshotLike.laboratory ?? null),
    documentAssets: buildSignaturePart(snapshotLike.documentAssets ?? null),
    documentIndex: buildSignaturePart(snapshotLike.documentIndex ?? null),
    isLearnMode: snapshotLike.isLearnMode,
    userProfile: buildSignaturePart(snapshotLike.userProfile),
    syllabus: buildSignaturePart(snapshotLike.syllabus),
    activeSectionId: snapshotLike.activeSectionId,
    activeLaboratoryExerciseId: snapshotLike.activeLaboratoryExerciseId,
  });
