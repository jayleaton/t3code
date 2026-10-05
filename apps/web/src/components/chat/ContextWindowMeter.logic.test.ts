import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("5.6 Sol");
  });

  it("falls back to the selected model slug when model metadata is unavailable", () => {
    const selectedInstanceId = ProviderInstanceId.make("codex-work");

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "custom-model",
        },
        new Map(),
      ),
    ).toBe("custom-model");
  });
});

describe("formatContextWindowCompactionMessage", () => {
  it("describes compaction in terms of the selected model", () => {
    expect(formatContextWindowCompactionMessage("GPT-5.6 Sol")).toBe(
      "Context for GPT-5.6 Sol compacts automatically when needed.",
    );
  });

  it("uses neutral copy when the model is unavailable", () => {
    expect(formatContextWindowCompactionMessage(null)).toBe(
      "Context compacts automatically when needed.",
    );
  });

  it("shows the configured auto-compaction threshold", () => {
    expect(formatContextWindowCompactionMessage("Claude Sonnet 5", 300_000)).toBe(
      "Compacts automatically at 300,000 tokens.",
    );
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves nothing once the detail is in", () => {
    expect(shouldReserveContextWindowMeter({ ...loadingStartedThread, detailLoading: false })).toBe(
      false,
    );
  });

  it("reserves nothing for a thread that never ran a turn", () => {
    expect(shouldReserveContextWindowMeter({ ...loadingStartedThread, threadStarted: false })).toBe(
      false,
    );
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });

  it("reserves nothing for a provider that does not stream usage", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: false,
      }),
    ).toBe(false);
  });

  it("reserves nothing while the meter is switched off", () => {
    expect(shouldReserveContextWindowMeter({ ...loadingStartedThread, meterEnabled: false })).toBe(
      false,
    );
  });
});

describe("formatContextWindowCost", () => {
  it("keeps ordinary and sub-cent ACP costs readable", () => {
    expect(formatContextWindowCost({ amount: 0.42, currency: "USD" })).toBe("USD 0.42");
    expect(formatContextWindowCost({ amount: 0.0042, currency: "USD" })).toBe("USD 0.0042");
  });
});
