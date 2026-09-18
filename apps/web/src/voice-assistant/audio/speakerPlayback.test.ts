import { afterEach, expect, it, vi } from "vite-plus/test";
import { createSpeakerPlayback } from "./speakerPlayback";

function harness() {
  const sources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    end: () => void;
  }> = [];
  const buffers: Float32Array[] = [];
  let now = 1;
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      get currentTime() {
        return now;
      }
      destination = {};
      createBuffer(_channels: number, length: number, rate: number) {
        const samples = new Float32Array(length);
        buffers.push(samples);
        return { duration: length / rate, getChannelData: () => samples };
      }
      createBufferSource() {
        let ended: (() => void) | undefined;
        const source = {
          buffer: null,
          connect() {},
          disconnect() {},
          start: vi.fn(),
          stop: vi.fn(),
          addEventListener: (_name: string, cb: () => void) => {
            ended = cb;
          },
          removeEventListener: () => {
            ended = undefined;
          },
          end: () => ended?.(),
        };
        sources.push(source);
        return source;
      }
      async resume() {}
      async close() {
        this.state = "closed";
      }
    },
  );
  return {
    sources,
    buffers,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it("keeps adjacent PCM chunks continuous and drains only after the last source", () => {
  const h = harness();
  const drained = vi.fn();
  const speaker = createSpeakerPlayback({ onDrained: drained });
  const pcm = new Uint8Array(480);
  for (let i = 1; i < pcm.length; i += 2) pcm[i] = 64;
  speaker.enqueue(pcm);
  speaker.enqueue(pcm);
  expect(h.buffers[0]![0]).toBe(0);
  expect(h.buffers[1]![0]).toBe(0.5);
  expect(h.buffers[0]!.at(-1)).toBe(0.5);
  expect(h.sources[1]!.start.mock.calls[0]![0]).toBeCloseTo(1.05);
  h.sources[0]!.end();
  expect(speaker.speaking).toBe(true);
  expect(drained).not.toHaveBeenCalled();
  h.sources[1]!.end();
  expect(speaker.speaking).toBe(false);
  expect(drained).toHaveBeenCalledOnce();
  speaker.dispose();
});

it("interruption cancels scheduled sound without flushing another announcement", () => {
  const h = harness();
  const drained = vi.fn();
  const speaker = createSpeakerPlayback({ onDrained: drained });
  speaker.enqueue(new Uint8Array([0, 64]));
  speaker.stop();
  h.sources[0]!.end();
  expect(h.sources[0]!.stop).toHaveBeenCalledOnce();
  expect(speaker.speaking).toBe(false);
  expect(drained).not.toHaveBeenCalled();
  speaker.dispose();
});

it("does not insert a gap when the next chunk arrives within the scheduling lead", () => {
  const h = harness();
  const speaker = createSpeakerPlayback();
  speaker.enqueue(new Uint8Array(4800)); // 100 ms, ends at 1.14
  h.advance(0.12);
  speaker.enqueue(new Uint8Array(4800));
  expect(h.sources[1]!.start.mock.calls[0]![0]).toBeCloseTo(1.14);
  speaker.dispose();
});
