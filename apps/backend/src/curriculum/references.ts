import type * as z from 'zod';
import type {
  CourseCurriculum,
  CurriculumArtifactRef,
  CurriculumEntityRef,
  CurriculumRef,
} from '../../../../packages/shared-types/curriculum';

type ProjectRef = Pick<CurriculumRef, 'userId' | 'projectId' | 'incarnationId'>;

export function sameProject(left: ProjectRef, right: ProjectRef): boolean {
  return (
    left.userId === right.userId &&
    left.projectId === right.projectId &&
    left.incarnationId === right.incarnationId
  );
}

export function sameCurriculum(left: CurriculumRef, right: CurriculumRef): boolean {
  return sameProject(left, right) && left.curriculumId === right.curriculumId;
}

export function sameArtifact(left: CurriculumArtifactRef, right: CurriculumArtifactRef): boolean {
  return (
    sameProject(left, right) &&
    left.artifactId === right.artifactId &&
    left.revisionId === right.revisionId
  );
}

export function report(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

export function checkUnique(
  context: z.RefinementCtx,
  ids: string[],
  path: (string | number)[]
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) report(context, [...path, index], `Duplicate identity: ${id}`);
    seen.add(id);
  });
}

export function checkEntity(
  context: z.RefinementCtx,
  entity: CurriculumEntityRef,
  curriculum: CourseCurriculum,
  path: (string | number)[]
): void {
  if (!sameCurriculum(entity.curriculum, curriculum.ref)) {
    report(context, path, 'Entity belongs to a different curriculum');
    return;
  }
  const exists =
    entity.kind === 'concept'
      ? curriculum.conceptIds.includes(entity.conceptId)
      : curriculum.objectives.some(objective => objective.objectiveId === entity.objectiveId);
  if (!exists) report(context, path, 'Unresolved curriculum entity');
}

export function entityKey(entity: CurriculumEntityRef): string {
  return JSON.stringify([
    entity.kind,
    entity.kind === 'concept' ? entity.conceptId : entity.objectiveId,
  ]);
}
