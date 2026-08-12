import type { Sql } from 'postgres';

import {
  publishProjectRevision,
  requestProjectRevisionCatchUp,
} from '../projects/projectEvents.js';
import type { ProjectRevisionEvent } from '../projects/types.js';
import type { WorkflowOutboxClaim } from './postgresWorkflowOutboxStore.js';
import { asPostgresJson } from './postgresWorkflowPersistence.js';
import type {
  WorkflowListenClient,
  WorkflowListenClientFactory,
} from './postgresWorkflowWakeSource.js';
import {
  COURSE_PROJECT_REVISION_EVENT,
  LESSON_PROJECT_REVISION_EVENT,
  PROJECT_REVISION_EVENT_SCHEMA_VERSION,
  ProjectRevisionEventSchema,
} from './projectRevisionNotifications.js';
import { failPermanently } from './retryPolicy.js';

const PROJECT_REVISION_NOTIFICATION_CHANNEL = 'project_revision_notification_ready';

interface StoredProjectRevisionNotificationRow {
  event_type: string;
  notification_id: string;
  payload: unknown;
  run_id: string;
  schema_version: number;
  sequence: string;
  user_id: string;
}

interface MatchingProjectRevisionNotificationRow extends StoredProjectRevisionNotificationRow {
  payload_matches: boolean;
}

type PublishProjectRevision = (userId: string, event: ProjectRevisionEvent) => void;

const isSupportedProjectRevisionEvent = (eventType: string): boolean =>
  eventType === COURSE_PROJECT_REVISION_EVENT || eventType === LESSON_PROJECT_REVISION_EVENT;

const assertMatchingNotification = (
  claim: WorkflowOutboxClaim,
  stored: MatchingProjectRevisionNotificationRow | undefined
): void => {
  if (
    stored?.notification_id !== claim.id ||
    stored?.run_id !== claim.runId ||
    stored?.user_id !== claim.userId ||
    stored?.event_type !== claim.eventType ||
    stored?.schema_version !== claim.schemaVersion ||
    stored?.sequence !== claim.sequence ||
    !stored?.payload_matches
  ) {
    throw failPermanently({
      code: 'notification_inbox_conflict',
      message: 'The durable notification conflicts with its persisted receiver acknowledgement.',
    });
  }
};

export class PostgresProjectRevisionInbox {
  private listener: WorkflowListenClient | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      readonly createListenClient: WorkflowListenClientFactory;
      readonly onListenerError?: (error: unknown) => void;
      readonly publishRevision?: PublishProjectRevision;
      readonly requestCatchUp?: () => void;
      readonly sql: Sql;
    }
  ) {}

  readonly deliver = async (claim: WorkflowOutboxClaim): Promise<void> => {
    await this.options.sql.begin(async transaction => {
      const inserted = await transaction<{ notification_id: string }[]>`
        insert into public.project_revision_notification_inbox (
          notification_id, run_id, user_id, event_type, schema_version, sequence, payload
        ) values (
          ${claim.id}, ${claim.runId}, ${claim.userId}, ${claim.eventType},
          ${claim.schemaVersion}, ${claim.sequence},
          ${transaction.json(asPostgresJson(claim.payload))}
        )
        on conflict (notification_id) do nothing
        returning notification_id
      `;
      const rows = await transaction<MatchingProjectRevisionNotificationRow[]>`
        select
          notification_id, run_id, user_id, event_type, schema_version,
          sequence::text, payload,
          payload = ${transaction.json(asPostgresJson(claim.payload))} as payload_matches
        from public.project_revision_notification_inbox
        where notification_id = ${claim.id}
      `;
      assertMatchingNotification(claim, rows[0]);
      if (inserted.length === 1) {
        await transaction`select pg_notify(${PROJECT_REVISION_NOTIFICATION_CHANNEL}, ${claim.id})`;
      }
    });
  };

  async start(): Promise<void> {
    if (this.listener) return;
    if (this.startPromise) return this.startPromise;
    const attempt = this.openListener();
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    const listener = this.listener;
    this.listener = null;
    if (listener) await listener.end({ timeout: 0 });
  }

  private async openListener(): Promise<void> {
    const listener = this.options.createListenClient();
    const catchUp = this.options.requestCatchUp ?? requestProjectRevisionCatchUp;
    try {
      await listener.listen(
        PROJECT_REVISION_NOTIFICATION_CHANNEL,
        notificationId => {
          void this.publishStoredNotification(notificationId).catch(error => {
            catchUp();
            (
              this.options.onListenerError ??
              (failure => console.error('[Workflow] Revision wake failed.', failure))
            )(error);
          });
        },
        catchUp
      );
      this.listener = listener;
    } catch (error) {
      await Promise.allSettled([listener.end({ timeout: 0 })]);
      throw error;
    }
  }

  private async publishStoredNotification(notificationId: string): Promise<void> {
    const rows = await this.options.sql<StoredProjectRevisionNotificationRow[]>`
      select
        notification_id, run_id, user_id, event_type, schema_version,
        sequence::text, payload
      from public.project_revision_notification_inbox
      where notification_id = ${notificationId}
    `;
    const stored = rows[0];
    if (!stored) return;
    if (
      !isSupportedProjectRevisionEvent(stored.event_type) ||
      stored.schema_version !== PROJECT_REVISION_EVENT_SCHEMA_VERSION
    ) {
      throw new Error(
        `Project revision notification ${notificationId} has an unsupported contract.`
      );
    }
    const event = ProjectRevisionEventSchema.parse(stored.payload);
    (this.options.publishRevision ?? publishProjectRevision)(stored.user_id, event);
  }
}
