import type { LibraryExportPhase } from '@shared/libraryExportContract';
import type {
  LibraryExportProjectCheckpoint,
  LibraryExportRunRecord,
  LibraryExportRunStore,
} from '../../src/projects/libraryExportRunStore.js';

export class MemoryLibraryExportRunStore implements LibraryExportRunStore {
  readonly runs = new Map<string, LibraryExportRunRecord>();
  readonly terminalTimes = new Map<string, number>();
  private readonly tokens = new Map<string, string>();
  private readonly cleaned = new Set<string>();

  get run() {
    return [...this.runs.values()].at(-1) ?? null;
  }
  set run(run: LibraryExportRunRecord | null) {
    if (run) this.runs.set(run.id, run);
    else this.runs.clear();
  }
  get cleanupCompleted() {
    return this.run ? this.cleaned.has(this.run.id) : false;
  }

  private requireRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run not found.');
    return run;
  }
  async createRun(input: Omit<LibraryExportRunRecord, 'checkpoints'>) {
    const existing = await this.findUndeliveredRun(input.userId);
    if (existing) return existing;
    const run = structuredClone({ ...input, checkpoints: [] });
    this.runs.set(run.id, run);
    return structuredClone(run);
  }
  async findUndeliveredRun(userId: string) {
    const run = [...this.runs.values()].find(
      run => run.userId === userId && run.status !== 'cancelled' && run.status !== 'downloaded'
    );
    return run ? structuredClone(run) : null;
  }
  async getRun(userId: string, runId: string) {
    const run = this.runs.get(runId);
    return run?.userId === userId ? structuredClone(run) : null;
  }
  async getRunProgress(userId: string, runId: string) {
    const run = this.runs.get(runId);
    if (run?.userId !== userId) return null;
    const {
      checkpoints,
      expectedProjects,
      folders: _folders,
      placements: _placements,
      ...progress
    } = run;
    return {
      ...progress,
      completedProjectCount: checkpoints.length,
      projectCount: expectedProjects.length,
    };
  }
  async authorizeDownload(userId: string, runId: string, tokenSha256: string, cutoff?: Date) {
    const run = this.runs.get(runId);
    if (
      run?.userId !== userId ||
      run.status !== 'completed' ||
      (cutoff && (this.terminalTimes.get(runId) ?? Infinity) <= cutoff.getTime())
    )
      return false;
    this.tokens.set(runId, tokenSha256);
    return true;
  }
  async claimDownload(runId: string, tokenSha256: string, cutoff?: Date) {
    const run = this.runs.get(runId);
    if (
      !run ||
      run.status !== 'completed' ||
      this.tokens.get(runId) !== tokenSha256 ||
      (cutoff && (this.terminalTimes.get(runId) ?? Infinity) <= cutoff.getTime())
    )
      return null;
    this.tokens.delete(runId);
    return structuredClone(run);
  }
  async listPendingCleanupRunIds() {
    return [...this.runs.values()]
      .filter(run => ['cancelled', 'downloaded'].includes(run.status) && !this.cleaned.has(run.id))
      .map(run => run.id);
  }
  async listRunningRuns() {
    return structuredClone([...this.runs.values()].filter(run => run.status === 'running'));
  }
  async listExpiredRunIds(cutoff: Date) {
    return [...this.runs.values()]
      .filter(
        run =>
          ['completed', 'failed'].includes(run.status) &&
          (this.terminalTimes.get(run.id) ?? Infinity) <= cutoff.getTime()
      )
      .map(run => run.id);
  }
  async cancelExpiredRun(runId: string, cutoff: Date) {
    if (!(await this.listExpiredRunIds(cutoff)).includes(runId)) return false;
    await this.markCancelled(runId, {
      code: 'LIBRARY_EXPORT_RETENTION_EXPIRED',
      detail: 'Retention elapsed.',
      phase: this.requireRun(runId).phase,
    });
    return true;
  }
  async markRunning(runId: string, phase: LibraryExportPhase, currentProjectId?: string) {
    const run = this.requireRun(runId);
    if (!['running', 'failed'].includes(run.status)) return;
    Object.assign(run, { status: 'running', phase, currentProjectId });
  }
  async checkpointProject(runId: string, checkpoint: LibraryExportProjectCheckpoint) {
    const run = this.requireRun(runId);
    run.checkpoints = [
      ...run.checkpoints.filter(entry => entry.projectId !== checkpoint.projectId),
      structuredClone(checkpoint),
    ];
    run.bytesWritten = run.checkpoints.reduce((total, entry) => total + entry.archiveBytes, 0);
  }
  async markCompleted(runId: string, archive: { bytes: number; sha256: string }) {
    this.terminalTimes.set(runId, Date.now());
    Object.assign(this.requireRun(runId), {
      status: 'completed',
      phase: 'ready',
      currentProjectId: undefined,
      archiveBytes: archive.bytes,
      archiveSha256: archive.sha256,
    });
    return true;
  }
  async markCancelled(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ) {
    Object.assign(this.requireRun(runId), {
      status: 'cancelled',
      phase: 'failed',
      errorCode: error.code,
      errorDetail: error.detail,
      errorPhase: error.phase,
    });
    this.tokens.delete(runId);
  }
  async markDownloaded(runId: string) {
    const run = this.requireRun(runId);
    if (run.status !== 'completed') return;
    run.status = 'downloaded';
    this.tokens.delete(runId);
  }
  async markCleanupCompleted(runId: string) {
    this.cleaned.add(runId);
  }
  async markFailed(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ) {
    if (!['running', 'completed'].includes(this.requireRun(runId).status)) return;
    this.terminalTimes.set(runId, Date.now());
    Object.assign(this.requireRun(runId), {
      status: 'failed',
      phase: 'failed',
      errorCode: error.code,
      errorDetail: error.detail,
      errorPhase: error.phase,
    });
    this.tokens.delete(runId);
  }
}
