import 'signalsmith-stretch';
import { PeakLimiter } from './peakLimiter';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class LessonPeakLimiter extends AudioWorkletProcessor {
  private limiter = new PeakLimiter();

  constructor() {
    super();
    this.port.onmessage = () => {
      this.limiter = new PeakLimiter();
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    this.limiter.process(inputs[0], outputs[0]);
    return true;
  }
}

registerProcessor('lesson-peak-limiter', LessonPeakLimiter);
