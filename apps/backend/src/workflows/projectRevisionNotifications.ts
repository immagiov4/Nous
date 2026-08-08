import type { TransactionSql } from 'postgres';
import * as z from 'zod';

import type { WorkflowOutboxClaim } from './postgresWorkflowOutboxStore.js';
import { appendWorkflowOutboxEvents } from './postgresWorkflowPersistence.js';
import { failPermanently } from './retryPolicy.js';
import type { WorkflowPublishedEventProjector } from './workflowRuntimeApi.js';

export const PROJECT_REVISION_EVENT_SCHEMA_VERSION = 1;
export const COURSE_PROJECT_REVISION_EVENT = 'course.project-revision';
export const LESSON_PROJECT_REVISION_EVENT = 'lesson.project-revision';

export const ProjectRevisionEventSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});

export const createProjectRevisionEventProjector =
  (eventType: string): WorkflowPublishedEventProjector =>
  state =>
    state.events.flatMap(event => {
      if (
        event.eventType !== eventType ||
        event.schemaVersion !== PROJECT_REVISION_EVENT_SCHEMA_VERSION
      ) {
        return [];
      }
      const payload = ProjectRevisionEventSchema.safeParse(event.payload);
      return payload.success ? [{ ...event, payload: payload.data }] : [];
    });

export const courseProjectRevisionEventProjector = createProjectRevisionEventProjector(
  COURSE_PROJECT_REVISION_EVENT
);

export const lessonProjectRevisionEventProjector = createProjectRevisionEventProjector(
  LESSON_PROJECT_REVISION_EVENT
);

export type ProjectRevisionNotificationReceiver = (claim: WorkflowOutboxClaim) => Promise<void>;

export type ProjectRevisionEventType =
  | typeof COURSE_PROJECT_REVISION_EVENT
  | typeof LESSON_PROJECT_REVISION_EVENT;

export const appendProjectRevisionNotification = async (
  transaction: TransactionSql,
  input: {
    readonly eventType: ProjectRevisionEventType;
    readonly projectId: string;
    readonly revision: number;
    readonly runId: string;
  }
): Promise<void> => {
  const payload = ProjectRevisionEventSchema.parse({
    projectId: input.projectId,
    revision: input.revision,
  });
  await appendWorkflowOutboxEvents(transaction, input.runId, [
    {
      eventType: input.eventType,
      payload,
      schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
    },
  ]);
};

export const createProjectRevisionNotificationDelivery =
  ({
    eventTypes,
    receiveNotification,
  }: {
    eventTypes: ReadonlySet<string>;
    receiveNotification: ProjectRevisionNotificationReceiver;
  }) =>
  async (claim: WorkflowOutboxClaim): Promise<void> => {
    if (
      !eventTypes.has(claim.eventType) ||
      claim.schemaVersion !== PROJECT_REVISION_EVENT_SCHEMA_VERSION
    ) {
      throw failPermanently({
        code: 'notification_unsupported',
        message: 'The durable workflow notification is not supported.',
      });
    }
    const payload = ProjectRevisionEventSchema.safeParse(claim.payload);
    if (!payload.success) {
      throw failPermanently({
        code: 'notification_payload_invalid',
        message: 'The durable workflow notification payload is invalid.',
      });
    }
    await receiveNotification(claim);
  };
