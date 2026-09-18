/**
 * Pure PCM conversion helpers shared by the microphone capture and speaker
 * playback layers. Kept free of browser globals so it stays unit-testable.
 */

const INT16_MAX = 32767;
const INT16_MIN = -32768;
const INT16_SCALE = 32768;

/**
 * Clamps to the unit range, scales to signed 16-bit, then rounds. Samples of
 * exactly +1 saturate to 32767 because the positive half of the range only
 * reaches that value; -1 maps to the full -32768.
 */
export function floatTo16BitPcm(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(clamped * INT16_SCALE)));
  }
  return output;
}

/** Inverse of {@link floatTo16BitPcm}: signed 16-bit to the unit range. */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = (samples[index] ?? 0) / INT16_SCALE;
  }
  return output;
}

/**
 * Resamples by linear interpolation. Returns the input untouched when the
 * rates match so the common case does no work and allocates nothing.
 */
export function downsampleToRate(
  samples: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (samples.length === 0 || inputRate <= 0 || outputRate <= 0 || inputRate === outputRate) {
    return samples;
  }
  const outputLength = Math.round((samples.length * outputRate) / inputRate);
  const output = new Float32Array(outputLength);
  const step = inputRate / outputRate;
  const lastIndex = samples.length - 1;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * step;
    const lowerIndex = Math.floor(position);
    const fraction = position - lowerIndex;
    const lower = samples[Math.min(lowerIndex, lastIndex)] ?? 0;
    const upper = samples[Math.min(lowerIndex + 1, lastIndex)] ?? 0;
    output[index] = lower + (upper - lower) * fraction;
  }
  return output;
}

/**
 * Explicit little-endian encoding rather than a view over the `Int16Array`
 * buffer, so the bytes are correct on big-endian hosts and genuinely copied.
 */
export function pcm16Bytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}
