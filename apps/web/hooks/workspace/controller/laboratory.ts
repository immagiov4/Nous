import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import {
  createLaboratoryAttachmentFromFile,
  createLaboratoryTextAttachment,
  updateLaboratoryTextAttachment as updateLaboratoryTextAttachmentContent,
} from '../../../services/laboratory/attachments.ts';
import {
  replaceLaboratoryExercise,
  selectActiveLaboratoryExercise,
  updateLaboratoryExercise,
  withLaboratoryStatus,
} from '../../../services/laboratory/state.ts';
import { AppState, type LaboratoryState } from '../../../types.ts';
import type { WorkspaceControllerContext } from './types.ts';

const resolveDefaultAttachmentName = (laboratory: LaboratoryState, countOffset = 1): string => {
  const markdownAttachmentCount = laboratory.exercises
    .flatMap(exercise => exercise.attachments)
    .filter(attachment => attachment.kind === 'text').length;

  return `note-lab-${markdownAttachmentCount + countOffset}.md`;
};

export const createLaboratoryCommands = (context: WorkspaceControllerContext) => {
  const { domain, openRouter, projectLibrary, state, stopAudio } = context;

  const getActiveExercise = () =>
    selectActiveLaboratoryExercise(domain.laboratory, domain.activeLaboratoryExerciseId);

  const persistActiveLaboratory = async (laboratory: LaboratoryState, activeExerciseId: string) => {
    await projectLibrary.saveCurrentProject({
      activeLaboratoryExerciseId: activeExerciseId,
      activeSectionId: null,
      laboratory,
      state: AppState.READING,
    });
  };

  const commitLaboratory = async (
    laboratory: LaboratoryState,
    options: {
      activeExerciseId?: string | null;
      persist?: boolean;
      clearActiveSection?: boolean;
    } = {}
  ) => {
    const nextActiveExerciseId =
      options.activeExerciseId === undefined
        ? domain.activeLaboratoryExerciseId
        : options.activeExerciseId;

    domain.setLaboratory(laboratory);

    if (options.clearActiveSection) {
      domain.setActiveSectionId(null);
    }

    if (options.activeExerciseId !== undefined) {
      domain.setActiveLaboratoryExerciseId(options.activeExerciseId);
    }

    if (options.persist === false) {
      return;
    }

    await projectLibrary.saveCurrentProject({
      activeLaboratoryExerciseId: nextActiveExerciseId,
      activeSectionId: options.clearActiveSection ? null : domain.activeSectionId,
      laboratory,
      state: AppState.READING,
    });
  };

  async function openLaboratoryExercise(exerciseId: string): Promise<'missing' | 'opened'> {
    if (!domain.laboratory?.exercises.some(exercise => exercise.id === exerciseId)) {
      return 'missing';
    }

    stopAudio(true);
    domain.setActiveSectionId(null);
    domain.setActiveLaboratoryExerciseId(exerciseId);
    await projectLibrary.saveCurrentProject({
      activeLaboratoryExerciseId: exerciseId,
      activeSectionId: null,
      state: AppState.READING,
    });
    return 'opened';
  }

  async function generateLaboratory(options?: {
    force?: boolean;
    openFirstExercise?: boolean;
  }): Promise<{ errorMessage?: string; outcome: 'failed' | 'generated' | 'noop' }> {
    if (!domain.learningPlan) {
      return {
        errorMessage: 'Il laboratorio puo essere generato solo dopo aver creato il percorso.',
        outcome: 'noop',
      };
    }

    if (domain.laboratory?.status === 'pending' && !options?.force) {
      return { outcome: 'noop' };
    }

    if (
      domain.laboratory?.status === 'ready' &&
      domain.laboratory.exercises.length > 0 &&
      !options?.force
    ) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow(
      'generateLaboratory',
      options?.force ? 'Rigenerazione laboratorio...' : 'Generazione laboratorio...'
    );
    const pendingLaboratory = withLaboratoryStatus(domain.laboratory, 'pending');
    domain.setLaboratory(pendingLaboratory);

    try {
      const laboratory = await openRouter.generateLaboratory({
        documentIndex: domain.documentIndex,
        learningPlan: domain.learningPlan,
        onStatus: message => {
          state.setWorkflowMessage('generateLaboratory', requestId, message);
        },
        onReasoning: reasoning => {
          state.setWorkflowReasoning('generateLaboratory', requestId, reasoning);
        },
        source: domain.source,
        userProfile: domain.userProfile,
      });

      if (!state.isWorkflowCurrent('generateLaboratory', requestId)) {
        return { outcome: 'noop' };
      }

      const shouldOpenFirstExercise = Boolean(
        options?.openFirstExercise ||
          (!domain.activeSectionId && !domain.activeLaboratoryExerciseId)
      );
      const activeExerciseId = shouldOpenFirstExercise
        ? laboratory.exercises[0]?.id || null
        : domain.activeLaboratoryExerciseId;

      await commitLaboratory(laboratory, {
        activeExerciseId,
        clearActiveSection: shouldOpenFirstExercise,
      });
      state.succeedWorkflow('generateLaboratory', requestId);
      return { outcome: 'generated' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      domain.setLaboratory(
        withLaboratoryStatus(domain.laboratory, 'failed', {
          errorMessage,
        })
      );
      state.failWorkflow('generateLaboratory', requestId, errorMessage);
      return { errorMessage, outcome: 'failed' };
    }
  }

  async function regenerateActiveLaboratoryExercise(): Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'noop' | 'regenerated';
  }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory || !domain.learningPlan) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow('generateLaboratory', 'Rigenerazione esercizio...');

    try {
      const regeneratedExercise = await openRouter.regenerateLaboratoryExercise({
        documentIndex: domain.documentIndex,
        exercise: activeExercise,
        learningPlan: domain.learningPlan,
        onStatus: message => {
          state.setWorkflowMessage('generateLaboratory', requestId, message);
        },
        onReasoning: reasoning => {
          state.setWorkflowReasoning('generateLaboratory', requestId, reasoning);
        },
        source: domain.source,
        userProfile: domain.userProfile,
      });

      if (!state.isWorkflowCurrent('generateLaboratory', requestId)) {
        return { outcome: 'noop' };
      }

      const nextLaboratory = replaceLaboratoryExercise(domain.laboratory, regeneratedExercise);
      await commitLaboratory(nextLaboratory, {
        activeExerciseId: regeneratedExercise.id,
        clearActiveSection: true,
      });
      state.succeedWorkflow('generateLaboratory', requestId);
      return { outcome: 'regenerated' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('generateLaboratory', requestId, errorMessage);
      return { errorMessage, outcome: 'failed' };
    }
  }

  async function evaluateActiveLaboratoryExercise(): Promise<{
    errorMessage?: string;
    outcome: 'evaluated' | 'failed' | 'noop';
  }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow('evaluateLaboratory', 'Valutazione laboratorio...');

    try {
      const evaluation = await openRouter.evaluateLaboratoryExercise({
        documentIndex: domain.documentIndex,
        exercise: activeExercise,
        learningPlan: domain.learningPlan,
        onStatus: message => {
          state.setWorkflowMessage('evaluateLaboratory', requestId, message);
        },
        onReasoning: reasoning => {
          state.setWorkflowReasoning('evaluateLaboratory', requestId, reasoning);
        },
        source: domain.source,
        userProfile: domain.userProfile,
      });

      if (!state.isWorkflowCurrent('evaluateLaboratory', requestId)) {
        return { outcome: 'noop' };
      }

      const nextLaboratory = updateLaboratoryExercise(
        domain.laboratory,
        activeExercise.id,
        exercise => ({
          ...exercise,
          evaluation,
        })
      );
      await commitLaboratory(nextLaboratory, {
        activeExerciseId: activeExercise.id,
        clearActiveSection: true,
      });
      state.succeedWorkflow('evaluateLaboratory', requestId);
      return { outcome: 'evaluated' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('evaluateLaboratory', requestId, errorMessage);
      return { errorMessage, outcome: 'failed' };
    }
  }

  async function addLaboratoryTextAttachment(options?: {
    content?: string;
    mimeType?: string;
    name?: string;
  }): Promise<{ attachmentId?: string; errorMessage?: string; outcome: 'added' | 'noop' }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory) {
      return { outcome: 'noop' };
    }

    const attachment = createLaboratoryTextAttachment({
      content: options?.content,
      mimeType: options?.mimeType,
      name: options?.name || resolveDefaultAttachmentName(domain.laboratory),
    });
    const nextLaboratory = updateLaboratoryExercise(
      domain.laboratory,
      activeExercise.id,
      exercise => ({
        ...exercise,
        attachments: [...exercise.attachments, attachment],
        evaluation: null,
      })
    );
    domain.setLaboratory(nextLaboratory);
    await persistActiveLaboratory(nextLaboratory, activeExercise.id);
    return { attachmentId: attachment.id, outcome: 'added' };
  }

  async function attachLaboratoryFiles(files: File[] | FileList): Promise<{
    errorMessage?: string;
    outcome: 'attached' | 'noop';
  }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory) {
      return { outcome: 'noop' };
    }

    try {
      const nextAttachments = await Promise.all(
        Array.from(files).map(file => createLaboratoryAttachmentFromFile(file))
      );
      const nextLaboratory = updateLaboratoryExercise(
        domain.laboratory,
        activeExercise.id,
        exercise => ({
          ...exercise,
          attachments: [...exercise.attachments, ...nextAttachments],
          evaluation: null,
        })
      );
      domain.setLaboratory(nextLaboratory);
      await persistActiveLaboratory(nextLaboratory, activeExercise.id);
      return { outcome: 'attached' };
    } catch (error) {
      return { errorMessage: getErrorMessage(error), outcome: 'noop' };
    }
  }

  async function updateLaboratoryTextAttachment(
    attachmentId: string,
    updates: { content: string; name?: string }
  ): Promise<{ errorMessage?: string; outcome: 'noop' | 'updated' }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory) {
      return { outcome: 'noop' };
    }

    const attachment = activeExercise.attachments.find(item => item.id === attachmentId);
    if (!attachment || attachment.kind !== 'text') {
      return { outcome: 'noop' };
    }

    const nextLaboratory = updateLaboratoryExercise(
      domain.laboratory,
      activeExercise.id,
      exercise => ({
        ...exercise,
        attachments: exercise.attachments.map(item =>
          item.id === attachmentId
            ? updateLaboratoryTextAttachmentContent(item, updates.content, updates.name)
            : item
        ),
        evaluation: null,
      })
    );
    domain.setLaboratory(nextLaboratory);
    await persistActiveLaboratory(nextLaboratory, activeExercise.id);
    return { outcome: 'updated' };
  }

  async function updateLaboratoryAttachmentMetadata(
    attachmentId: string,
    updates: { description?: string; name?: string }
  ): Promise<{ errorMessage?: string; outcome: 'noop' | 'updated' }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory) {
      return { outcome: 'noop' };
    }

    const hasTargetAttachment = activeExercise.attachments.some(item => item.id === attachmentId);
    if (!hasTargetAttachment) {
      return { outcome: 'noop' };
    }

    const nextLaboratory = updateLaboratoryExercise(
      domain.laboratory,
      activeExercise.id,
      exercise => ({
        ...exercise,
        attachments: exercise.attachments.map(item =>
          item.id === attachmentId
            ? {
                ...item,
                description: updates.description,
                name: updates.name || item.name,
                updatedAt: new Date().toISOString(),
              }
            : item
        ),
        evaluation: null,
      })
    );
    domain.setLaboratory(nextLaboratory);
    await persistActiveLaboratory(nextLaboratory, activeExercise.id);
    return { outcome: 'updated' };
  }

  async function removeLaboratoryAttachment(attachmentId: string): Promise<{
    errorMessage?: string;
    outcome: 'noop' | 'removed';
  }> {
    const activeExercise = getActiveExercise();
    if (!activeExercise || !domain.laboratory) {
      return { outcome: 'noop' };
    }

    if (!activeExercise.attachments.some(item => item.id === attachmentId)) {
      return { outcome: 'noop' };
    }

    const nextLaboratory = updateLaboratoryExercise(
      domain.laboratory,
      activeExercise.id,
      exercise => ({
        ...exercise,
        attachments: exercise.attachments.filter(item => item.id !== attachmentId),
        evaluation: null,
      })
    );
    domain.setLaboratory(nextLaboratory);
    await persistActiveLaboratory(nextLaboratory, activeExercise.id);
    return { outcome: 'removed' };
  }

  return {
    addLaboratoryTextAttachment,
    attachLaboratoryFiles,
    evaluateActiveLaboratoryExercise,
    generateLaboratory,
    openLaboratoryExercise,
    regenerateActiveLaboratoryExercise,
    removeLaboratoryAttachment,
    updateLaboratoryAttachmentMetadata,
    updateLaboratoryTextAttachment,
  };
};
