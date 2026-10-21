import SignalsmithStretch from 'signalsmith-stretch';
import workletUrl from './signalsmithWorklet?worker&url';

// Ship the complete module: serialized functions can refer to bundle-local helpers.
SignalsmithStretch.moduleUrl = workletUrl;

// Preserve the library's default clock notification interval.
const CLOCK_UPDATE_SECONDS = 0.1;

export type PlaybackRecording = { index: number; buffer: AudioBuffer };
export type PlaybackPosition = { index: number; time: number; duration: number };
type BufferedRecording = PlaybackRecording & { begin: number; end: number };
type StretchNode = Awaited<ReturnType<typeof SignalsmithStretch>>;

/** One sample stream preserves pitch and passage boundaries without event-driven hand-offs. */
export class LessonPlaybackAudio {
  private context!: AudioContext;
  private node: Promise<StretchNode>;
  private failed = false;
  private operation = Promise.resolve();
  private recordings: BufferedRecording[] = [];
  private anchor: { input: number; output: number; speed: number } | null = null;
  private pausedPosition: PlaybackPosition | null = null;
  private generation = 0;
  private speed = 1;
  private lastPosition: PlaybackPosition | null = null;
  onPosition: ((position: PlaybackPosition) => void) | null = null;
  onEnded: (() => void) | null = null;
  onError: ((error: unknown) => void) | null = null;

  constructor() {
    this.node = this.initialize();
  }

  private initialize() {
    const node = this.createNode();
    void node.catch(error => {
      if (this.node === node) this.reportError(error);
    });
    return node;
  }

  private async createNode() {
    const context = new AudioContext();
    this.context = context;
    context.onstatechange = () => {
      if (this.context === context && context.state === 'closed')
        this.reportError(new Error('Audio context closed'));
    };
    const node = await SignalsmithStretch(context, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.onprocessorerror = () => {
      if (this.context === context) this.reportError(new Error('Audio processing failed'));
    };
    node.connect(context.destination);
    await node.setUpdateInterval(CLOCK_UPDATE_SECONDS, this.tick);
    return node;
  }

  async unlock() {
    if (this.failed) {
      this.releaseContext();
      this.failed = false;
      this.operation = Promise.resolve();
      this.node = this.initialize();
    }
    return this.resumeContext();
  }

  private async resumeContext() {
    const context = this.context;
    try {
      await context.resume();
    } catch (error) {
      if (this.context === context) this.reportError(error);
      throw error;
    }
  }
  async decode(bytes: Uint8Array): Promise<AudioBuffer> {
    await this.node;
    return this.context.decodeAudioData(Uint8Array.from(bytes).buffer);
  }

  get position(): PlaybackPosition | null {
    if (!this.anchor) return this.pausedPosition;
    const input = this.inputTime();
    const active =
      this.recordings.find(recording => recording.end > input) ?? this.recordings.at(-1);
    if (!active) return this.pausedPosition;
    return {
      index: active.index,
      duration: active.buffer.duration,
      time: Math.min(active.buffer.duration, Math.max(0, input - active.begin)),
    };
  }

  async start(
    recordings: readonly PlaybackRecording[],
    offset: number,
    speed: number,
    signal: AbortSignal
  ) {
    this.pause();
    const generation = this.generation;
    this.speed = speed;
    await this.resumeContext();
    signal.throwIfAborted();
    await this.enqueue(async node => {
      if (generation !== this.generation) return;
      signal.throwIfAborted();
      await node.dropBuffers();
      this.recordings = [];
      await this.addRecordings(node, recordings);
      signal.throwIfAborted();
      if (generation !== this.generation) return;
      const input = Math.min(offset, recordings[0].buffer.duration);
      const output = this.context.currentTime;
      this.anchor = { input, output, speed: this.speed };
      // outputTime is required by the published worklet's scheduling implementation.
      await node.schedule({
        active: true,
        input,
        output,
        outputTime: output,
        rate: this.speed,
        semitones: 0,
      });
      if (generation !== this.generation) return;
      this.lastPosition = null;
      this.publish();
      this.tick();
    });
  }

  select(recording: PlaybackRecording, offset: number) {
    this.pause();
    this.pausedPosition = {
      index: recording.index,
      time: offset,
      duration: recording.buffer.duration,
    };
    this.lastPosition = null;
  }

  append(recordings: readonly PlaybackRecording[]) {
    const generation = this.generation;
    return this.enqueue(async node => {
      if (!this.anchor || generation !== this.generation) return;
      const last = this.recordings.at(-1);
      // A late append must not turn elapsed silence into skipped narration.
      if (last && this.inputTime() >= last.end) {
        this.tick();
        return;
      }
      await this.addRecordings(
        node,
        recordings.filter(recording => !last || recording.index > last.index)
      );
    });
  }

  changeSpeed(speed: number) {
    this.speed = speed;
    if (!this.anchor || this.anchor.speed === speed) return;
    const input = this.inputTime();
    const output = this.context.currentTime;
    this.anchor = { input, output, speed };
    const session = this.node;
    void session
      .then(node => node.schedule({ input, output, outputTime: output, rate: speed, semitones: 0 }))
      .catch(error => {
        if (this.node === session) this.reportError(error);
      });
  }

  pause() {
    this.stopClock();
    if (this.failed) return;
    const session = this.node;
    void this.enqueue(async node => {
      await node.stop();
    }).catch(error => {
      if (this.node === session) this.reportError(error);
    });
  }

  close() {
    this.stopClock();
    this.onPosition = null;
    this.onEnded = null;
    this.releaseContext();
  }

  private releaseContext() {
    if (!this.context) return;
    this.context.onstatechange = null;
    void this.context.close().catch(error => console.error('Lesson audio close failed', error));
  }

  private enqueue(operation: (node: StretchNode) => Promise<void>): Promise<void> {
    const session = this.node;
    const next = this.operation.then(() => session).then(operation);
    // Each caller observes its own error; later user actions can still recover.
    this.operation = next.catch(() => {});
    return next;
  }

  private async addRecordings(node: StretchNode, recordings: readonly PlaybackRecording[]) {
    await Promise.all(
      recordings.map(recording => {
        const begin = this.recordings.at(-1)?.end ?? 0;
        this.recordings.push({ ...recording, begin, end: begin + recording.buffer.duration });
        // One message port preserves sample order; acknowledge the whole batch before playback.
        return node.addBuffers(
          Array.from({ length: recording.buffer.numberOfChannels }, (_, channel) =>
            recording.buffer.getChannelData(channel)
          )
        );
      })
    );
  }

  private inputTime() {
    const anchor = this.anchor;
    if (!anchor) throw new Error('Audio clock must be running');
    return anchor.input + Math.max(0, this.context.currentTime - anchor.output) * anchor.speed;
  }

  private stopClock() {
    this.pausedPosition = this.position;
    this.anchor = null;
    this.generation++;
  }

  private reportError(error: unknown) {
    this.stopClock();
    this.failed = true;
    console.error('Lesson audio failed', error);
    this.onError?.(error);
  }

  private publish() {
    const position = this.position;
    if (!position) return;
    if (
      position.index !== this.lastPosition?.index ||
      Math.floor(position.time) !== Math.floor(this.lastPosition.time)
    ) {
      this.lastPosition = position;
      this.onPosition?.(position);
    }
  }

  private tick = () => {
    if (!this.anchor) return;
    this.publish();
    const last = this.recordings.at(-1);
    if (last && this.inputTime() >= last.end) {
      this.pause();
      this.onEnded?.();
      return;
    }
  };
}
