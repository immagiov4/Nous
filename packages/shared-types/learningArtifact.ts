const LEARNING_ARTIFACT_KINDS = ['future-asset', 'generated-visual', 'pdf-image'] as const;
export const LEARNING_ARTIFACT_ID_SEPARATOR = ':';

export type LearningArtifactKind = (typeof LEARNING_ARTIFACT_KINDS)[number];

export const buildLearningArtifactId = ({
  artifactId,
  kind,
  lessonId,
  projectId,
}: {
  artifactId: string;
  kind: LearningArtifactKind;
  lessonId: string;
  projectId: string;
}): string => [projectId, lessonId, kind, artifactId].join(LEARNING_ARTIFACT_ID_SEPARATOR);

export const isLearningArtifactKind = (value: unknown): value is LearningArtifactKind =>
  LEARNING_ARTIFACT_KINDS.some(kind => kind === value);
