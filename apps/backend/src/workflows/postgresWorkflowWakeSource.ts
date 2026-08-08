import type {
  WorkflowRuntimeWake,
  WorkflowRuntimeWakeSource,
  WorkflowRuntimeWakeSubscription,
} from './workflowRuntimeWorker.js';

export interface WorkflowListenClient {
  end(options?: { timeout?: number }): Promise<void>;
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void
  ): Promise<{ unlisten(): Promise<void> }>;
}

export type WorkflowListenClientFactory = () => WorkflowListenClient;

const NOTIFICATION_CHANNELS: ReadonlyArray<{
  channel: string;
  wake: WorkflowRuntimeWake;
}> = [
  { channel: 'workflow_ready', wake: 'step' },
  { channel: 'workflow_undo_ready', wake: 'undo' },
  { channel: 'workflow_notification_ready', wake: 'notification' },
  { channel: 'workflow_cleanup', wake: 'cancellation-reconciliation' },
];

export class PostgresWorkflowWakeSource implements WorkflowRuntimeWakeSource {
  constructor(private readonly createClient: WorkflowListenClientFactory) {}

  async subscribe(
    listener: (wake: WorkflowRuntimeWake) => void
  ): Promise<WorkflowRuntimeWakeSubscription> {
    const sql = this.createClient();
    try {
      for (const notification of NOTIFICATION_CHANNELS) {
        await sql.listen(
          notification.channel,
          () => listener(notification.wake),
          () => listener('all')
        );
      }
    } catch (error) {
      await Promise.allSettled([sql.end({ timeout: 0 })]);
      throw error;
    }

    let closed = false;
    let closing: Promise<void> | null = null;
    return {
      unsubscribe: () => {
        if (closed) return Promise.resolve();
        if (closing) return closing;
        const attempt = sql
          .end({ timeout: 0 })
          .then(() => {
            closed = true;
          })
          .finally(() => {
            if (closing === attempt) closing = null;
          });
        closing = attempt;
        return attempt;
      },
    };
  }
}
