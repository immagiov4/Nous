export const LEARNING_ARTIFACT_KINDS = ['future-asset', 'generated-visual', 'pdf-image'] as const;

export type LearningArtifactKind = (typeof LEARNING_ARTIFACT_KINDS)[number];

export const isLearningArtifactKind = (value: unknown): value is LearningArtifactKind =>
  LEARNING_ARTIFACT_KINDS.some(kind => kind === value);
