import type { FeedbackBreadcrumb } from '@shared/feedbackDiagnosticsContract';

export interface FeedbackBreadcrumbListItem {
  breadcrumb: FeedbackBreadcrumb;
  key: string;
}

export const createFeedbackBreadcrumbListItems = (
  breadcrumbs: FeedbackBreadcrumb[]
): FeedbackBreadcrumbListItem[] => {
  const occurrenceByBreadcrumb = new Map<string, number>();
  return breadcrumbs.map(breadcrumb => {
    const baseKey = `${breadcrumb.timestamp}-${breadcrumb.operation}-${breadcrumb.surface}-${breadcrumb.projectId || ''}-${breadcrumb.sectionId || ''}`;
    const occurrence = occurrenceByBreadcrumb.get(baseKey) || 0;
    occurrenceByBreadcrumb.set(baseKey, occurrence + 1);
    return { breadcrumb, key: `${baseKey}-${occurrence}` };
  });
};
