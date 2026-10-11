// MPEG Layer III bitrate tables (kb/s), indexed by the four-bit header field.
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const MPEG_SAMPLE_RATE_DIVISORS = [4, 0, 2, 1]; // Version bits: 2.5, reserved, 2, 1.
const ID3_HEADER_BYTES = 10;
const ID3V1_BYTES = 128;
const MPEG1_SAMPLES_PER_FRAME = 1152;
const MPEG2_SAMPLES_PER_FRAME = 576;

const audioStart = (bytes: Buffer): number => {
  if (bytes.toString('ascii', 0, 3) !== 'ID3') return 0;
  if (bytes.length < ID3_HEADER_BYTES || bytes.subarray(6, 10).some(byte => byte & 0x80)) {
    throw new Error('Invalid MP3 ID3 header.');
  }
  const size = bytes.subarray(6, 10).reduce((total, byte) => total * 128 + byte, 0);
  const footerBytes = bytes[3] === 4 && bytes[5] & 0x10 ? ID3_HEADER_BYTES : 0;
  return ID3_HEADER_BYTES + size + footerBytes;
};

/** Sums complete MPEG Layer III frames, including VBR streams; skips ID3 metadata. */
export const mp3DurationSeconds = (audio: Uint8Array): number => {
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  let offset = audioStart(bytes);
  const end =
    bytes.length >= ID3V1_BYTES &&
    bytes.toString('ascii', bytes.length - ID3V1_BYTES, bytes.length - ID3V1_BYTES + 3) === 'TAG'
      ? bytes.length - ID3V1_BYTES
      : bytes.length;
  let duration = 0;
  while (offset + 4 <= end) {
    const header = bytes.readUInt32BE(offset);
    const version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const sampleRateIndex = (header >>> 10) & 3;
    const padding = (header >>> 9) & 1;
    if (
      header >>> 21 !== 0x7ff ||
      version === 1 ||
      layer !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      throw new Error('Invalid MPEG Layer III frame header.');
    }
    const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex] / MPEG_SAMPLE_RATE_DIVISORS[version];
    const bitrate = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex] * 1000;
    const samples = version === 3 ? MPEG1_SAMPLES_PER_FRAME : MPEG2_SAMPLES_PER_FRAME;
    const frameBytes = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
    if (offset + frameBytes > end) throw new Error('Truncated MP3 frame.');
    duration += samples / sampleRate;
    offset += frameBytes;
  }
  if (!duration || offset !== end) throw new Error('Incomplete MP3 audio.');
  return duration;
};
