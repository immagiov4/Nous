import type {
  FeedbackBreadcrumbOperation,
  FeedbackProductSurface,
  FeedbackWorkflowOperation,
  FeedbackWorkflowStatus,
} from '@shared/feedbackDiagnosticsContract';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';

const PRODUCT_SURFACE_LABELS: Record<FeedbackProductSurface, () => string> = {
  assessment: () => t('Valutazione iniziale'),
  'contextual-chat': () => t('Chat contestuale'),
  home: () => t('Home'),
  library: () => t('Libreria'),
  planning: () => t('Pianificazione'),
  reader: () => t('Lettore'),
};

const WORKFLOW_OPERATION_LABELS: Record<FeedbackWorkflowOperation, () => string> = {
  'create-lesson': () => t('Creazione lezione'),
  'generate-course': () => t('Generazione corso'),
  'load-section': () => t('Caricamento lezione'),
};

const WORKFLOW_STATUS_LABELS: Record<FeedbackWorkflowStatus, () => string> = {
  completed: () => t('Completato'),
  failed: () => t('Non riuscito'),
  queued: () => t('In coda'),
  running: () => t('In corso'),
};

const BREADCRUMB_OPERATION_LABELS: Record<FeedbackBreadcrumbOperation, () => string> = {
  'opened-project': () => t('Corso aperto'),
  'opened-section': () => t('Lezione aperta'),
  'updated-workflow': () => t('Attività aggiornata'),
  'visited-surface': () => t('Area visitata'),
};

export const getFeedbackProductSurfaceLabel = (surface: FeedbackProductSurface): string =>
  PRODUCT_SURFACE_LABELS[surface]();

export const getFeedbackWorkflowOperationLabel = (operation: FeedbackWorkflowOperation): string =>
  WORKFLOW_OPERATION_LABELS[operation]();

export const getFeedbackWorkflowStatusLabel = (status: FeedbackWorkflowStatus): string =>
  WORKFLOW_STATUS_LABELS[status]();

export const getFeedbackBreadcrumbOperationLabel = (
  operation: FeedbackBreadcrumbOperation
): string => BREADCRUMB_OPERATION_LABELS[operation]();
