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

type SignatureInput =
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
      | 'researchCoursePlan'
      | 'researchDossiersBySectionId'
      | 'activeSectionId'
      | 'activeLaboratoryExerciseId'
    >
  | WorkspaceDomainState;

export const buildPersistenceSignature = (snapshotLike: SignatureInput): string =>
  JSON.stringify({
    source: buildSignaturePart(snapshotLike.source),
    learningPlan: buildSignaturePart(snapshotLike.learningPlan),
    laboratory: buildSignaturePart(snapshotLike.laboratory ?? null),
    documentAssets: buildSignaturePart(snapshotLike.documentAssets ?? null),
    documentIndex: buildSignaturePart(snapshotLike.documentIndex ?? null),
    isLearnMode: snapshotLike.isLearnMode,
    userProfile: buildSignaturePart(snapshotLike.userProfile),
    syllabus: buildSignaturePart(snapshotLike.syllabus),
    researchCoursePlan: buildSignaturePart(snapshotLike.researchCoursePlan ?? null),
    researchDossiersBySectionId: buildSignaturePart(snapshotLike.researchDossiersBySectionId ?? {}),
    activeSectionId: snapshotLike.activeSectionId,
    activeLaboratoryExerciseId: snapshotLike.activeLaboratoryExerciseId,
  });

// Reference-identity token used by the autosave-fast-path signature: avoids
// JSON.stringifying a possibly huge `source` (PDF base64) on every domainState
// change — that cost hundreds of ms per render even with the WeakMap cache,
// because any object spread invalidated it.
const sourceTokens = new WeakMap<object, number>();
let nextSourceToken = 1;
const sourceIdentityToken = (source: unknown): number => {
  if (!source || typeof source !== 'object') return 0;
  let token = sourceTokens.get(source);
  if (token === undefined) {
    token = nextSourceToken++;
    sourceTokens.set(source, token);
  }
  return token;
};

// Signature used by the autosave loop: identical to buildPersistenceSignature
// but skips serializing `source` (it never changes after import, so a reference
// token is enough). NOT interchangeable with buildPersistenceSignature for
// content-equality checks (e.g. LAN transfer verification) because two
// otherwise-identical snapshots loaded from different stores will have
// different source object identities.
export const buildAutosaveSignature = (snapshotLike: SignatureInput): string =>
  JSON.stringify({
    sourceRef: sourceIdentityToken(snapshotLike.source),
    learningPlan: buildSignaturePart(snapshotLike.learningPlan),
    laboratory: buildSignaturePart(snapshotLike.laboratory ?? null),
    documentAssets: buildSignaturePart(snapshotLike.documentAssets ?? null),
    documentIndex: buildSignaturePart(snapshotLike.documentIndex ?? null),
    isLearnMode: snapshotLike.isLearnMode,
    userProfile: buildSignaturePart(snapshotLike.userProfile),
    syllabus: buildSignaturePart(snapshotLike.syllabus),
    researchCoursePlan: buildSignaturePart(snapshotLike.researchCoursePlan ?? null),
    researchDossiersBySectionId: buildSignaturePart(snapshotLike.researchDossiersBySectionId ?? {}),
    activeSectionId: snapshotLike.activeSectionId,
    activeLaboratoryExerciseId: snapshotLike.activeLaboratoryExerciseId,
  });
