import { describe, expect, it } from "vite-plus/test";

import { downsampleToRate, floatTo16BitPcm, int16ToFloat32, pcm16Bytes } from "./pcm.ts";

describe("floatTo16BitPcm", () => {
  it("converts known unit-range values", () => {
    const result = floatTo16BitPcm(new Float32Array([0, 1, -1, 0.5]));

    expect(Array.from(result)).toEqual([0, 32767, -32768, 16384]);
  });

  it("clamps values outside the unit range", () => {
    const result = floatTo16BitPcm(new Float32Array([2, -2, 1.5, -1.5]));

    expect(Array.from(result)).toEqual([32767, -32768, 32767, -32768]);
  });
});

describe("int16ToFloat32", () => {
  it("divides each sample by 32768", () => {
    const result = int16ToFloat32(new Int16Array([0, 16384, -32768, 32767]));

    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0.5);
    expect(result[2]).toBe(-1);
    expect(result[3]).toBeCloseTo(32767 / 32768, 10);
  });

  it("round-trips values produced by floatTo16BitPcm", () => {
    const roundTripped = int16ToFloat32(floatTo16BitPcm(new Float32Array([0, 0.5, -1])));

    expect(Array.from(roundTripped)).toEqual([0, 0.5, -1]);
  });
});

describe("downsampleToRate", () => {
  it("returns the input untouched when the rates match", () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);

    expect(downsampleToRate(samples, 16000, 16000)).toBe(samples);
  });

  it("downsamples 48kHz to 16kHz with the expected length and values", () => {
    const samples = new Float32Array([0, 1, 2, 3, 4, 5]);

    const result = downsampleToRate(samples, 48000, 16000);

    expect(result.length).toBe(2);
    expect(Array.from(result)).toEqual([0, 3]);
  });

  it("linearly interpolates between source samples", () => {
    const samples = new Float32Array([0, 1, 2]);

    const result = downsampleToRate(samples, 48000, 32000);

    expect(result.length).toBe(2);
    expect(Array.from(result)).toEqual([0, 1.5]);
  });

  it("returns an empty result for empty input", () => {
    expect(downsampleToRate(new Float32Array([]), 48000, 16000).length).toBe(0);
  });
});

describe("pcm16Bytes", () => {
  it("writes little-endian bytes for known values", () => {
    const bytes = pcm16Bytes(new Int16Array([0x1234, -2]));

    expect(Array.from(bytes)).toEqual([0x34, 0x12, 0xfe, 0xff]);
  });

  it("returns a copy that does not alias the source buffer", () => {
    const samples = new Int16Array([1, 2]);

    const bytes = pcm16Bytes(samples);
    bytes[0] = 0xff;

    expect(samples[0]).toBe(1);
  });
});
