import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectStore } from '../projects/types.js';
import { timestampIso } from '../utils/time.js';
import { createCourseLessonChunkBatchMapper } from './courseChunkMapping.js';
import { createCourseExercisePlanningStage } from './courseExercisePlanning.js';
import { createCourseArchiveOpener } from './courseGenerationArchiveAccess.js';
import { createCourseArchivePlanningStages } from './courseGenerationArchivePlanning.js';
import {
  createCoursePersistenceStage,
  createCourseResultFinalizer,
} from './courseGenerationPersistence.js';
import { createCoursePlanningStages } from './courseGenerationPlanning.js';
import { createCoursePreparationStage } from './courseGenerationPreparation.js';
import { createCourseResearchServices } from './courseGenerationResearch.js';
import { createCourseSourceMaterialReader } from './courseGenerationSources.js';
import type { CourseGenerationWorkflowServices } from './courseGenerationWorkflow.js';
import { createCourseSourceFinalizationServices } from './courseSourceFinalization.js';
import { buildCourseDocumentIndex } from './courseSourceIndex.js';

type CourseWorkflowStore = {
  readonly courseGenerationPersistence: Pick<
    CourseGenerationWorkflowServices,
    'persistCourse' | 'undoCourse'
  >;
};

export const createProductionCourseGenerationServices = (
  workflowStore: CourseWorkflowStore,
  projectStore: ProjectStore = getProjectStore()
): CourseGenerationWorkflowServices => {
  const loadProjectSources = projectStore.loadProjectSources.bind(projectStore);
  const loadProjectWithRevision = projectStore.loadProjectWithRevision.bind(projectStore);
  const readSourceMaterials = createCourseSourceMaterialReader({
    loadProjectSources,
    loadProjectWithRevision,
  });
  const planning = createCoursePlanningStages({
    now: timestampIso,
    readSourceMaterials,
  });
  const archivePlanning = createCourseArchivePlanningStages({
    now: timestampIso,
    openArchive: createCourseArchiveOpener({
      loadProjectSourceArchiveEntry: projectStore.loadProjectSourceArchiveEntry.bind(projectStore),
      loadProjectSourceArchiveEntryRange:
        projectStore.loadProjectSourceArchiveEntryRange.bind(projectStore),
      loadProjectSourceArchiveIndex: projectStore.loadProjectSourceArchiveIndex.bind(projectStore),
      loadProjectWithRevision,
    }),
  });
  const persistence = workflowStore.courseGenerationPersistence;

  return {
    ...planning,
    ...archivePlanning,
    buildCoursePersistence: createCoursePersistenceStage({
      loadProjectWithRevision,
      now: timestampIso,
    }),
    finalizeCourse: createCourseResultFinalizer({ loadProjectWithRevision }),
    ...createCourseSourceFinalizationServices({
      buildDocumentIndex: buildCourseDocumentIndex,
      mapBatch: createCourseLessonChunkBatchMapper(),
      now: timestampIso,
      readSourceMaterials,
    }),
    ...createCourseResearchServices({ readSourceMaterials }),
    persistCourse: persistence.persistCourse,
    placeApplicationExercises: createCourseExercisePlanningStage({ now: timestampIso }),
    prepareCourse: createCoursePreparationStage({
      loadProjectSources,
      loadProjectWithRevision,
    }),
    undoCourse: persistence.undoCourse,
  };
};
