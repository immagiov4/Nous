export const FEEDBACK_PRODUCT_SURFACES = [
  'assessment',
  'contextual-chat',
  'home',
  'library',
  'planning',
  'reader',
] as const;

export type FeedbackProductSurface = (typeof FEEDBACK_PRODUCT_SURFACES)[number];

export const FEEDBACK_BREADCRUMB_OPERATIONS = [
  'opened-project',
  'opened-section',
  'updated-workflow',
  'visited-surface',
] as const;

export type FeedbackBreadcrumbOperation = (typeof FEEDBACK_BREADCRUMB_OPERATIONS)[number];

export const FEEDBACK_WORKFLOW_OPERATIONS = [
  'assessment-interview',
  'create-lesson',
  'generate-course',
  'load-section',
] as const;

export type FeedbackWorkflowOperation = (typeof FEEDBACK_WORKFLOW_OPERATIONS)[number];

export const FEEDBACK_WORKFLOW_STATUSES = [
  'cancelled',
  'completed',
  'expired',
  'failed',
  'queued',
  'running',
  'waiting',
] as const;

export type FeedbackWorkflowStatus = (typeof FEEDBACK_WORKFLOW_STATUSES)[number];

export const MAX_FEEDBACK_BREADCRUMB_ENTRIES = 25;

export interface FeedbackProductReference {
  id: string;
  revision?: number;
}

export interface FeedbackWorkflowSnapshot {
  operation: FeedbackWorkflowOperation;
  runId: string;
  status: FeedbackWorkflowStatus;
}

export interface FeedbackBreadcrumb {
  operation: FeedbackBreadcrumbOperation;
  projectId?: string;
  sectionId?: string;
  surface: FeedbackProductSurface;
  timestamp: string;
}

export interface FeedbackProductContext {
  breadcrumbs?: FeedbackBreadcrumb[];
  project?: FeedbackProductReference;
  section?: FeedbackProductReference;
  surface?: FeedbackProductSurface;
  workflow?: FeedbackWorkflowSnapshot;
}
