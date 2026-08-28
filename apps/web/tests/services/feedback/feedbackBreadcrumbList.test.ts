import type { FeedbackBreadcrumb } from '@shared/feedbackDiagnosticsContract';
import { expect, test } from 'vitest';
import { createFeedbackBreadcrumbListItems } from '../../../services/feedback/feedbackBreadcrumbList.ts';

test('assigns stable distinct keys to otherwise identical breadcrumb events', () => {
  const breadcrumb: FeedbackBreadcrumb = {
    operation: 'updated-workflow',
    projectId: 'project-12345678',
    surface: 'planning',
    timestamp: '2026-07-16T10:00:00.000Z',
  };

  expect(createFeedbackBreadcrumbListItems([breadcrumb, breadcrumb]).map(item => item.key)).toEqual(
    [
      '2026-07-16T10:00:00.000Z-updated-workflow-planning-project-12345678--0',
      '2026-07-16T10:00:00.000Z-updated-workflow-planning-project-12345678--1',
    ]
  );
});
