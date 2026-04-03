const applyEdgeFade = (pcmData: ArrayBuffer, sampleRate: number): ArrayBuffer => {
  const samples = new Int16Array(pcmData.slice(0));
  const fadeSamples = Math.min(
    Math.floor(sampleRate * 0.008),
    Math.floor(samples.length / 2)
  );

  if (fadeSamples < 2) {
    return samples.buffer;
  }

  for (let index = 0; index < fadeSamples; index += 1) {
    const gain = index / fadeSamples;
    const tailIndex = samples.length - 1 - index;

    samples[index] = Math.round(samples[index] * gain);
    samples[tailIndex] = Math.round(samples[tailIndex] * gain);
  }

  return samples.buffer;
};

export const createWavBlob = (pcmData: ArrayBuffer, sampleRate = 24000): Blob => {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const fadedPcmData = applyEdgeFade(pcmData, sampleRate);
  const dataSize = fadedPcmData.byteLength;
  const headerSize = 44;

  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  return new Blob([header, fadedPcmData], { type: 'audio/wav' });
};
