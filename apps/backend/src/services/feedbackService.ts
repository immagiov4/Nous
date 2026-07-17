import {
  type FeedbackReportPage,
  type FeedbackScreenshot,
  type NewFeedbackReport,
  PostgresFeedbackStore,
  type StoredFeedbackReport,
} from './feedbackStore.js';
import { GithubFeedbackError, GithubFeedbackPublisher } from './githubFeedback.js';

const OUTBOX_POLL_INTERVAL_MS = 30_000;
const OUTBOX_BATCH_SIZE = 4;
const GITHUB_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const GITHUB_SYNC_MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

type FeedbackStore = Pick<
  PostgresFeedbackStore,
  | 'claimForDelivery'
  | 'create'
  | 'getScreenshot'
  | 'list'
  | 'markDeliveryFailed'
  | 'markSubmitted'
  | 'retry'
  | 'upsertGithubIssues'
>;

type FeedbackPublisher = Pick<GithubFeedbackPublisher, 'isConfigured' | 'listIssues' | 'publish'>;

export interface FeedbackSubmission {
  created: boolean;
  report: StoredFeedbackReport;
}

export interface GithubFeedbackSyncResult {
  issueCount: number;
  synchronizedAt: string;
}

export class FeedbackService {
  private githubSyncPromise: Promise<GithubFeedbackSyncResult> | null = null;

  constructor(
    private readonly store: FeedbackStore = new PostgresFeedbackStore(),
    private readonly publisher: FeedbackPublisher = new GithubFeedbackPublisher()
  ) {}

  async submit(input: NewFeedbackReport): Promise<FeedbackSubmission> {
    return this.store.create(input);
  }

  list(page: number, pageSize: number): Promise<FeedbackReportPage> {
    return this.store.list(page, pageSize);
  }

  getScreenshot(id: string): Promise<FeedbackScreenshot | null> {
    return this.store.getScreenshot(id);
  }

  async retry(id: string): Promise<boolean> {
    return this.store.retry(id);
  }

  isGithubConfigured(): boolean {
    return this.publisher.isConfigured();
  }

  async syncGithub(): Promise<GithubFeedbackSyncResult> {
    if (this.githubSyncPromise) {
      return this.githubSyncPromise;
    }
    if (!this.publisher.isConfigured()) {
      throw new GithubFeedbackError('github_not_configured');
    }

    this.githubSyncPromise = this.performGithubSync();
    try {
      return await this.githubSyncPromise;
    } finally {
      this.githubSyncPromise = null;
    }
  }

  async dispatchNextPending(): Promise<boolean> {
    const report = await this.claimForDelivery();
    if (!report) {
      return false;
    }

    await this.publishClaimed(report);
    return true;
  }

  private async claimForDelivery(id?: string): Promise<StoredFeedbackReport | null> {
    try {
      if (!this.publisher.isConfigured()) {
        return null;
      }
    } catch (error) {
      console.error('[Nous][Feedback] Invalid GitHub feedback configuration.', error);
      return null;
    }
    return this.store.claimForDelivery(id);
  }

  private async publishClaimed(report: StoredFeedbackReport): Promise<StoredFeedbackReport> {
    try {
      const issue = await this.publisher.publish(report);
      await this.store.markSubmitted(report.id, issue.number, issue.url);
      return {
        ...report,
        githubIssueNumber: issue.number,
        githubIssueState: 'open',
        githubIssueUrl: issue.url,
        status: 'submitted',
      };
    } catch (error) {
      const errorCode = error instanceof GithubFeedbackError ? error.code : 'github_unknown_error';
      const exponentialRetryDelay = Math.min(
        INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, report.attemptCount - 1),
        MAX_RETRY_DELAY_MS
      );
      const retryDelay = Math.max(
        exponentialRetryDelay,
        error instanceof GithubFeedbackError ? error.retryAfterMs : 0
      );
      await this.store.markDeliveryFailed(report.id, errorCode, new Date(Date.now() + retryDelay));
      console.warn('[Nous][Feedback] GitHub delivery deferred.', {
        errorCode,
        feedbackId: report.id,
      });
      return { ...report, status: 'pending' };
    }
  }

  private async performGithubSync(): Promise<GithubFeedbackSyncResult> {
    const issues = await this.publisher.listIssues();
    const issueCount = await this.store.upsertGithubIssues(issues);
    return { issueCount, synchronizedAt: new Date().toISOString() };
  }
}

let feedbackService: FeedbackService | null = null;
let outboxInterval: ReturnType<typeof setInterval> | null = null;
let outboxTickRunning = false;
let githubSyncFailures = 0;
let nextGithubSyncAt = 0;

export const getFeedbackService = (): FeedbackService => {
  feedbackService ??= new FeedbackService();
  return feedbackService;
};

export const setFeedbackServiceForTesting = (service: FeedbackService | null): void => {
  feedbackService = service;
};

const runGithubSyncIfDue = async (): Promise<void> => {
  const now = Date.now();
  if (now < nextGithubSyncAt) {
    return;
  }

  try {
    const service = getFeedbackService();
    if (service.isGithubConfigured()) {
      await service.syncGithub();
    }
    githubSyncFailures = 0;
    nextGithubSyncAt = now + GITHUB_SYNC_INTERVAL_MS;
  } catch (error) {
    githubSyncFailures += 1;
    const retryDelay = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (githubSyncFailures - 1),
      GITHUB_SYNC_MAX_RETRY_DELAY_MS
    );
    nextGithubSyncAt = now + retryDelay;
    console.warn('[Nous][Feedback] GitHub synchronization deferred.', error);
  }
};

const runOutboxTick = async (): Promise<void> => {
  if (outboxTickRunning) {
    return;
  }

  outboxTickRunning = true;
  try {
    try {
      for (let deliveredCount = 0; deliveredCount < OUTBOX_BATCH_SIZE; deliveredCount += 1) {
        if (!(await getFeedbackService().dispatchNextPending())) break;
      }
    } catch (error) {
      console.error('[Nous][Feedback] Outbox tick failed.', error);
    }
    await runGithubSyncIfDue();
  } finally {
    outboxTickRunning = false;
  }
};

export const startFeedbackOutboxWorker = (): void => {
  if (outboxInterval) {
    return;
  }

  void runOutboxTick();
  outboxInterval = setInterval(() => void runOutboxTick(), OUTBOX_POLL_INTERVAL_MS);
  outboxInterval.unref();
};

export const kickFeedbackOutboxWorker = (): void => {
  if (!outboxInterval) return;
  void runOutboxTick();
};

export const stopFeedbackOutboxWorker = (): void => {
  if (outboxInterval) {
    clearInterval(outboxInterval);
    outboxInterval = null;
  }
};
