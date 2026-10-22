declare module 'signalsmith-stretch' {
  const SignalsmithStretch: {
    moduleUrl: string;
    (
      context: AudioContext,
      options: AudioWorkletNodeOptions
    ): Promise<
      AudioWorkletNode & {
        schedule(change: {
          active?: boolean;
          input?: number;
          output?: number;
          outputTime?: number;
          rate?: number;
          semitones?: number;
        }): Promise<{
          active?: boolean;
          input?: number;
          output?: number;
          outputTime?: number;
          rate?: number;
          semitones?: number;
        }>;
        setUpdateInterval(seconds: number, update: () => void): Promise<unknown>;
        stop(): Promise<unknown>;
        addBuffers(channels: Float32Array[]): Promise<number>;
        dropBuffers(): Promise<unknown>;
      }
    >;
  };
  export default SignalsmithStretch;
}
