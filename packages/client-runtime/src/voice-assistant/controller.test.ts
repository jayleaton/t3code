import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceAssistantController } from "./controller.ts";
import type {
  VoiceAssistantState,
  VoiceCapturePort,
  VoiceConversationPort,
  VoicePlaybackPort,
  VoiceTimerHandle,
} from "./ports.ts";

class FakeCapture implements VoiceCapturePort {
  readonly openWake = vi.fn(async () => undefined);
  readonly closeWake = vi.fn(async () => undefined);
  readonly beginUtterance = vi.fn(async () => undefined);
  readonly endUtterance = vi.fn(async () => undefined);
  readonly preRoll = vi.fn(() => null as Uint8Array | null);
  readonly dispose = vi.fn(async () => undefined);
}

class FakeConversation implements VoiceConversationPort {
  readonly connect = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);
  readonly sendAudio = vi.fn();
  readonly sendText = vi.fn();
  readonly finalizeInput = vi.fn();
  readonly cancel = vi.fn();
}

class FakePlayback implements VoicePlaybackPort {
  readonly stop = vi.fn(async () => undefined);
}

interface ScheduledTimer {
  readonly handle: VoiceTimerHandle;
  readonly ms: number;
  readonly callback: () => void;
}

function createTimerHarness() {
  let nextId = 1;
  let timers: ScheduledTimer[] = [];
  return {
    setTimer: (callback: () => void, ms: number): VoiceTimerHandle => {
      const handle = { id: nextId++ };
      timers.push({ handle, ms, callback });
      return handle;
    },
    clearTimer: (handle: VoiceTimerHandle): void => {
      timers = timers.filter((timer) => timer.handle.id !== handle.id);
    },
    pending: () => timers.map((timer) => timer.ms),
    fire: (ms: number): void => {
      const target = timers.find((timer) => timer.ms === ms);
      if (target === undefined) throw new Error(`No timer scheduled for ${ms}ms`);
      timers = timers.filter((timer) => timer !== target);
      target.callback();
    },
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function createHarness() {
  const capture = new FakeCapture();
  const conversation = new FakeConversation();
  const playback = new FakePlayback();
  const timers = createTimerHarness();
  const states: VoiceAssistantState[] = [];
  const controller = new VoiceAssistantController({
    ports: { capture, conversation, playback },
    conversationProvider: "gemini",
    silenceTimeoutSeconds: 5,
    onStateChange: (state) => states.push(state),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { controller, capture, conversation, playback, timers, states };
}

describe("VoiceAssistantController input lifecycle", () => {
  it("push-to-talk idle keeps the microphone released and uploads nothing", async () => {
    const { controller, capture, conversation } = createHarness();
    await controller.setMode("push-to-talk");

    expect(controller.getState().input).toBe("standby");
    expect(controller.getState().microphone).toBe("released");
    expect(capture.openWake).not.toHaveBeenCalled();
    expect(capture.beginUtterance).not.toHaveBeenCalled();
    expect(conversation.sendAudio).not.toHaveBeenCalled();
  });

  it("wake mode opens a local detection pipeline and never uploads ambient audio", async () => {
    const { controller, capture, conversation } = createHarness();
    await controller.setMode("wake-word");

    expect(capture.openWake).toHaveBeenCalledTimes(1);
    expect(capture.beginUtterance).not.toHaveBeenCalled();
    expect(conversation.sendAudio).not.toHaveBeenCalled();
    expect(controller.getState().microphone).toBe("wake-listening");
  });

  it("off releases capture and transport resources", async () => {
    const { controller, capture, conversation } = createHarness();
    await controller.setMode("wake-word");
    await controller.setMode("off");

    expect(capture.closeWake).toHaveBeenCalled();
    expect(controller.getState().input).toBe("off");
    expect(controller.getState().microphone).toBe("released");
    expect(controller.getState().output).toBe("idle");
    expect(conversation.cancel).toHaveBeenCalled();
  });

  it("a no-speech activation closes silently without a model turn", async () => {
    const { controller, capture, conversation, timers } = createHarness();
    await controller.setMode("wake-word");
    await controller.handleWakeDetected();
    await flush();

    expect(controller.getState().input).toBe("capturing");
    timers.fire(5000);

    expect(conversation.finalizeInput).not.toHaveBeenCalled();
    expect(conversation.cancel).toHaveBeenCalled();
    expect(controller.getState().input).toBe("standby");
    expect(capture.endUtterance).toHaveBeenCalled();
  });

  it("accepted speech extends the window and finalizes once on silence", async () => {
    const { controller, capture, conversation, timers } = createHarness();
    await controller.setMode("wake-word");
    await controller.handleWakeDetected();
    await flush();

    controller.handleAcceptedSpeech();
    controller.handleFinalTranscript("what is the mobile agent doing");
    timers.fire(5000);
    await flush();

    expect(capture.endUtterance).toHaveBeenCalled();
    expect(conversation.finalizeInput).toHaveBeenCalledTimes(1);
    expect(controller.getState().input).toBe("finalizing");

    controller.handleAssistantSpeechEnd();
    expect(controller.getState().input).toBe("standby");
  });

  it("uses the configured silence timeout and resets it only on accepted speech", async () => {
    const { controller, timers, conversation } = createHarness();
    await controller.setMode("wake-word");
    controller.setSilenceTimeoutSeconds(10);
    await controller.handleWakeDetected();
    await flush();

    expect(timers.pending()).toContain(10000);

    // Ambient noise and assistant output do not extend the window.
    controller.handlePartialTranscript("");
    controller.handleAssistantSpeechStart();
    expect(timers.pending()).toContain(10000);

    timers.fire(10000);
    expect(conversation.cancel).toHaveBeenCalled();
  });

  it("push-to-talk release finalizes immediately, independent of the timer", async () => {
    const { controller, capture, conversation } = createHarness();
    await controller.setMode("push-to-talk");
    await controller.pressPushToTalk();
    await flush();

    await controller.releasePushToTalk();

    expect(capture.endUtterance).toHaveBeenCalled();
    expect(conversation.finalizeInput).toHaveBeenCalledTimes(1);
    expect(controller.getState().input).toBe("finalizing");
  });

  it("push-to-talk interrupts playback before capturing", async () => {
    const { controller, playback } = createHarness();
    await controller.setMode("push-to-talk");
    controller.announce("The desktop agent needs approval.");
    controller.handleAssistantSpeechStart();
    expect(controller.getState().output).toBe("speaking");

    await controller.pressPushToTalk();

    expect(playback.stop).toHaveBeenCalled();
    expect(controller.getState().output).toBe("idle");
    expect(controller.getState().input).toBe("capturing");
  });

  it("cancel invalidates a late transcript so a stale command cannot execute", async () => {
    const { controller, conversation } = createHarness();
    await controller.setMode("push-to-talk");
    await controller.pressPushToTalk();
    await flush();
    const generation = controller.getState().sessionGeneration;

    controller.cancel();
    controller.handleFinalTranscript("delete the production database");
    controller.handleAcceptedSpeech();

    expect(controller.getState().sessionGeneration).toBeGreaterThan(generation);
    expect(controller.getState().input).toBe("standby");
    expect(conversation.finalizeInput).not.toHaveBeenCalled();
  });

  it("announces agent events while the microphone is off", async () => {
    const { controller, conversation } = createHarness();

    await controller.setMode("push-to-talk");
    controller.announce("Mobile layout finished its turn.");
    await flush();

    expect(conversation.sendText).toHaveBeenCalledWith("Mobile layout finished its turn.");
    expect(controller.getState().lastAnnouncement).toBe("Mobile layout finished its turn.");
  });

  it("queues announcements during capture instead of speaking over the user", async () => {
    const { controller, conversation } = createHarness();
    await controller.setMode("push-to-talk");
    await controller.pressPushToTalk();
    await flush();

    controller.announce("The API agent is asking which database to use.");
    expect(conversation.sendText).not.toHaveBeenCalled();

    await controller.releasePushToTalk();
    controller.handleAssistantSpeechEnd();
    await flush();

    expect(conversation.sendText).toHaveBeenCalledWith(
      "The API agent is asking which database to use.",
    );
  });

  it("stop speaking stops playback without cancelling already-started agent work", async () => {
    const { controller, playback } = createHarness();
    await controller.setMode("push-to-talk");
    controller.announce("Mobile layout finished its turn.");
    controller.handleAssistantSpeechStart();

    await controller.stopSpeaking();

    expect(playback.stop).toHaveBeenCalled();
    expect(controller.getState().output).toBe("idle");
    // Stops speech, not a T3 operation on an agent.
    expect(controller.getState().mode).toBe("push-to-talk");
  });
});

describe("voice session regressions", () => {
  it("never applies a silence deadline while push-to-talk is held", async () => {
    const { controller, timers } = createHarness();
    await controller.setMode("push-to-talk");
    await controller.pressPushToTalk();
    await flush();
    expect(timers.pending()).not.toContain(5000);
    expect(controller.getState().input).toBe("capturing");
  });

  it("cancel closes capture and stops queued playback", async () => {
    const { controller, capture, playback } = createHarness();
    await controller.setMode("push-to-talk");
    await controller.pressPushToTalk();
    controller.cancel();
    expect(capture.endUtterance).toHaveBeenCalled();
    expect(playback.stop).toHaveBeenCalled();
  });

  it("PTT stops the speaker even after the provider reports completion", async () => {
    const { controller, playback } = createHarness();
    await controller.setMode("push-to-talk");
    controller.handleAssistantSpeechEnd();
    await controller.pressPushToTalk();
    expect(playback.stop).toHaveBeenCalled();
  });

  it("queues events while preparing or speaking", async () => {
    const { controller, conversation } = createHarness();
    await controller.setMode("push-to-talk");
    controller.announce("first");
    controller.announce("second");
    await flush();
    expect(conversation.sendText).toHaveBeenCalledTimes(1);
    controller.handleAssistantSpeechEnd();
    await flush();
    expect(conversation.sendText).toHaveBeenLastCalledWith("second");
  });
});
