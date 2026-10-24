/** Stereo-linked, one-block lookahead. Gain ramps precede peaks instead of clipping samples. */
export class PeakLimiter {
  private previous: Float32Array[] = [];
  private previousCeiling = 1;
  private gain = 1;

  process(input: Float32Array[], output: Float32Array[]) {
    const frames = output[0].length;
    let peak = 1;
    for (const channel of input)
      for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    const ceiling = 1 / peak;
    // Adjacent block peaks bound both ends of the ramp, including its recovery to unity.
    const start = Math.min(this.gain, this.previousCeiling);
    const end = Math.min(this.previousCeiling, ceiling);
    for (let channel = 0; channel < output.length; channel++) {
      const previous = this.previous[channel];
      for (let frame = 0; frame < frames; frame++)
        output[channel][frame] =
          (previous?.[frame] ?? 0) * (start + ((end - start) * frame) / frames);
      this.previous[channel] ??= new Float32Array(frames);
      if (input[channel]) this.previous[channel].set(input[channel]);
      else this.previous[channel].fill(0);
    }
    this.previousCeiling = ceiling;
    this.gain = end;
  }
}
