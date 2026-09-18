import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMicrophoneCapture } from "./microphoneCapture";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function harness() {
  const tracks: Array<{ readyState: string; stop: () => void }> = [];
  const worklets: Array<{ emit: (data: Float32Array) => void }> = [];
  let grant: (() => void) | undefined;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(
        () =>
          new Promise((resolve) => {
            grant = () => {
              const track = {
                readyState: "live",
                stop() {
                  this.readyState = "ended";
                },
              };
              tracks.push(track);
              resolve({ getTracks: () => [track] });
            };
          }),
      ),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      sampleRate = 16000;
      destination = {};
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      async resume() {}
      async close() {
        this.state = "closed";
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      private receive: ((event: { data: Float32Array }) => void) | undefined;
      port = {
        addEventListener: (_name: string, cb: typeof this.receive) => {
          this.receive = cb;
        },
        removeEventListener() {},
        start() {},
      };
      constructor() {
        worklets.push({ emit: (data) => this.receive?.({ data }) });
      }
      connect() {}
      disconnect() {}
    },
  );
  return { tracks, worklets, grant: () => grant?.() };
}
afterEach(() => vi.unstubAllGlobals());

describe("microphone resource lifecycle", () => {
  it("releases actual tracks and closes upload on release, then reacquires for the next turn", async () => {
    const h = harness();
    const onFrame = vi.fn();
    const mic = createMicrophoneCapture({ onFrame });
    const first = mic.beginUtterance();
    await flush();
    h.grant();
    await first;
    h.worklets[0]!.emit(new Float32Array([0.5, -0.5]));
    expect(onFrame).toHaveBeenCalledOnce();
    await mic.endUtterance();
    expect(h.tracks[0]!.readyState).toBe("ended");
    h.worklets[0]!.emit(new Float32Array([0.5]));
    expect(onFrame).toHaveBeenCalledOnce();
    const next = mic.beginUtterance();
    await flush();
    h.grant();
    await next;
    expect(h.tracks[1]!.readyState).toBe("live");
    await mic.dispose();
    expect(h.tracks[1]!.readyState).toBe("ended");
  });

  it("a late permission grant cannot reopen capture after cancellation", async () => {
    const h = harness();
    const mic = createMicrophoneCapture();
    const start = mic.beginUtterance();
    await flush();
    const stop = mic.endUtterance();
    h.grant();
    await Promise.all([start, stop]);
    expect(mic.getStreaming()).toBe(false);
    expect(h.tracks[0]!.readyState).toBe("ended");
    await mic.dispose();
  });

  it("local microphone testing never uploads audio", async () => {
    const h = harness();
    const onFrame = vi.fn();
    const mic = createMicrophoneCapture({ onFrame });
    const start = mic.start();
    await flush();
    h.grant();
    await start;
    h.worklets[0]!.emit(new Float32Array([0.5]));
    expect(onFrame).not.toHaveBeenCalled();
    await mic.endUtterance();
    expect(h.tracks[0]!.readyState).toBe("ended");
    await mic.dispose();
  });
});
