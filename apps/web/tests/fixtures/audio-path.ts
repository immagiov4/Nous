import { alignedWordTimes, narrationWords } from '@shared/playbackWordTiming';
import { captionMotionEvents, motionStates } from '../../components/workspace/playback/stageMotion';
import { LessonPlaybackAudio } from '../../utils/reader/lessonPlaybackAudio';

declare global {
  interface Window {
    renderUnity: typeof renderUnity;
    renderProcessed: typeof renderProcessed;
  }
}

async function renderUnity() {
  const rate = 48_000;
  const context = new OfflineAudioContext(2, rate, rate);
  context.resume = async () => {};
  Object.assign(context, { close: async () => {} });
  const originalContext = window.AudioContext;
  window.AudioContext = new Proxy(originalContext, { construct: () => context });
  const connections: string[] = [];
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (
    this: AudioNode,
    ...args: Parameters<AudioNode['connect']>
  ) {
    connections.push(this.constructor.name);
    return Reflect.apply(connect, this, args);
  } as AudioNode['connect'];
  try {
    const audio = new LessonPlaybackAudio();
    const buffer = context.createBuffer(1, rate, rate);
    const source = buffer.getChannelData(0);
    for (let i = 0; i < source.length; i++) source[i] = 0.8 * Math.sin((i * i) / rate);
    await audio.start([{ index: 0, buffer }], 0, 1, new AbortController().signal);
    const rendered = await context.startRendering();
    let error = 0;
    for (let i = 0; i < source.length; i++)
      error = Math.max(error, Math.abs(source[i] - rendered.getChannelData(0)[i]));
    audio.close();
    return { error, connections };
  } finally {
    window.AudioContext = originalContext;
    AudioNode.prototype.connect = connect;
  }
}
window.renderUnity = renderUnity;

export async function renderProcessed(options: {
  speed: number;
  rate?: number;
  bytes?: number[];
  samples?: boolean;
  switches?: { at: number; speed: number }[];
  checkpoints?: number[];
}) {
  const rate = options.rate ?? 48_000;
  const decoder = new OfflineAudioContext(2, rate, rate);
  const buffer = options.bytes
    ? await decoder.decodeAudioData(new Uint8Array(options.bytes).buffer)
    : decoder.createBuffer(1, rate * 4, rate);
  if (!options.bytes) {
    const pcm = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      const t = i / rate;
      // A chirp followed by isolated acoustic word markers.
      pcm[i] =
        t < 0.8
          ? Math.sin((i * i) / rate)
          : (t >= 1.5 && t < 1.54) || (t >= 2.5 && t < 2.54)
            ? 0.8 * Math.sin((i * Math.PI) / 24)
            : 0;
    }
  }
  const context = new OfflineAudioContext(
    2,
    Math.ceil(rate * (buffer.duration / Math.min(options.speed, 0.75) + 1)),
    rate
  );
  const resume = context.resume.bind(context);
  context.resume = async () => {};
  Object.assign(context, { close: async () => {} });
  const original = window.AudioContext;
  window.AudioContext = new Proxy(original, { construct: () => context });
  const audio = new LessonPlaybackAudio();
  const clock: { before: number; after: number; wall: number; speed: number }[] = [];
  const cues: { wall: number; opacities: number[] }[] = [];
  const speech = 'first second';
  const events = captionMotionEvents({
    events: ['first', 'second'].map(quote => ({ quote, effect: 'reveal', targets: [quote] })),
    speech,
    speechRanges: narrationWords(speech),
    runs: [
      { span: document.createElement('span'), start: 0, width: 1 },
      { span: document.createElement('span'), start: 1, width: 1 },
    ],
    width: 2,
    feather: 0,
    duration: buffer.duration,
    aligned: alignedWordTimes(speech, buffer.duration, { status: 'aligned', onsets: [1.5, 2.5] }),
  });
  try {
    await audio.start([{ index: 0, buffer }], 0, options.speed, new AbortController().signal);
    const changes = [
      ...(options.switches ?? []),
      ...(options.checkpoints ?? []).map(at => ({ at, speed: undefined })),
    ].sort((left, right) => left.at - right.at);
    const suspensions = changes.map(change => ({
      change,
      suspended: context.suspend(change.at),
    }));
    const rendering = context.startRendering();
    for (const { change, suspended } of suspensions) {
      await suspended;
      const before = audio.position?.time ?? 0;
      if (change.speed !== undefined) audio.changeSpeed(change.speed);
      // Drain actual worklet RPCs while the render clock is suspended.
      await audio.append([]);
      if (change.speed !== undefined)
        clock.push({
          before,
          after: audio.position?.time ?? 0,
          wall: context.currentTime,
          speed: change.speed,
        });
      else
        cues.push({
          wall: context.currentTime,
          opacities: [
            ...motionStates(['first', 'second'], events, before * 1000, true, 0).values(),
          ].map(state => state.opacity),
        });
      await resume();
    }
    const rendered = await rendering;
    const samples = rendered.getChannelData(0);
    let peak = 0,
      sourcePeak = 0;
    let unityError = 0;
    if (options.speed === 1 && !options.switches)
      for (let i = 0; i < buffer.length; i++)
        unityError = Math.max(unityError, Math.abs(buffer.getChannelData(0)[i] - samples[i]));
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    for (const sample of buffer.getChannelData(0))
      sourcePeak = Math.max(sourcePeak, Math.abs(sample));
    const markers: number[] = [];
    for (let i = rate; i < samples.length; i++) {
      if (
        Math.abs(samples[i]) > 0.2 &&
        (!markers.length || i / rate - markers[markers.length - 1] > 0.2)
      )
        markers.push(i / rate);
    }
    return {
      peak,
      sourcePeak,
      unityError,
      clock,
      cues,
      markers,
      duration: buffer.duration,
      samples: options.samples ? Array.from(samples) : undefined,
      rate,
    };
  } finally {
    audio.close();
    window.AudioContext = original;
  }
}
window.renderProcessed = renderProcessed;
