import type { SectionPatch } from '@shared/projectContract';
import type { LearningPlan, ProjectSnapshot, WorkspaceDomainState } from '../../types';

import { findPathNodeById } from '../../utils/learning/pathNodes.ts';

// Optional fields can disappear in JSON and return at a different insertion position.
// Signature equality follows stored values, not object construction order.
const stringifySignaturePart = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => left.localeCompare(right))
        )
      : nested
  );

const objectSignatureCache = new WeakMap<object, string>();

const buildSignaturePart = <T>(value: T): T | string => {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const cachedSignature = objectSignatureCache.get(value);
  if (cachedSignature) {
    return cachedSignature;
  }

  const signature = stringifySignaturePart(value);
  objectSignatureCache.set(value, signature);
  return signature;
};

type SignatureInput =
  | Pick<
      ProjectSnapshot,
      | 'source'
      | 'learningPlan'
      | 'documentAssets'
      | 'documentIndex'
      | 'isLearnMode'
      | 'userProfile'
      | 'syllabus'
      | 'researchCoursePlan'
      | 'researchDossiersBySectionId'
      | 'activeSectionId'
    >
  | WorkspaceDomainState;

export const buildPersistenceSignature = (snapshotLike: SignatureInput): string =>
  JSON.stringify({
    source: buildSignaturePart(snapshotLike.source),
    learningPlan: buildSignaturePart(snapshotLike.learningPlan),
    documentAssets: buildSignaturePart(snapshotLike.documentAssets ?? null),
    documentIndex: buildSignaturePart(snapshotLike.documentIndex ?? null),
    isLearnMode: snapshotLike.isLearnMode,
    userProfile: buildSignaturePart(snapshotLike.userProfile),
    syllabus: buildSignaturePart(snapshotLike.syllabus),
    researchCoursePlan: buildSignaturePart(snapshotLike.researchCoursePlan ?? null),
    researchDossiersBySectionId: buildSignaturePart(snapshotLike.researchDossiersBySectionId ?? {}),
    activeSectionId: snapshotLike.activeSectionId,
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
// content-equality checks because two
// otherwise-identical snapshots loaded from different stores will have
// different source object identities.
export const buildAutosaveSignature = (snapshotLike: SignatureInput): string =>
  JSON.stringify({
    sourceRef: sourceIdentityToken(snapshotLike.source),
    learningPlan: buildSignaturePart(snapshotLike.learningPlan),
    documentAssets: buildSignaturePart(snapshotLike.documentAssets ?? null),
    documentIndex: buildSignaturePart(snapshotLike.documentIndex ?? null),
    isLearnMode: snapshotLike.isLearnMode,
    userProfile: buildSignaturePart(snapshotLike.userProfile),
    syllabus: buildSignaturePart(snapshotLike.syllabus),
    researchCoursePlan: buildSignaturePart(snapshotLike.researchCoursePlan ?? null),
    researchDossiersBySectionId: buildSignaturePart(snapshotLike.researchDossiersBySectionId ?? {}),
    activeSectionId: snapshotLike.activeSectionId,
  });

/** Advances only the fields committed by a section PATCH, retaining other dirty edits. */
export const acknowledgeSectionPatch = (signature: string, patch: SectionPatch): string => {
  if (!signature) return signature;
  const baseline: { learningPlan: string | null } = JSON.parse(signature);
  if (!baseline.learningPlan) return signature;
  const learningPlan: LearningPlan = JSON.parse(baseline.learningPlan);
  const section = findPathNodeById(learningPlan.modules, patch.sectionId);
  if (section?.kind !== 'lesson') return signature;
  for (const [field, value] of Object.entries(patch)) {
    if (field !== 'sectionId' && value !== undefined) Object.assign(section, { [field]: value });
  }
  baseline.learningPlan = stringifySignaturePart(learningPlan);
  return JSON.stringify(baseline);
};
