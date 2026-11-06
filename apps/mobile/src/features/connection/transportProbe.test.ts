import { describe, expect, it } from "vite-plus/test";

import { probeTransports, transportProbeVerdict, type Transport } from "./transportProbe";

const target = {
  httpBaseUrl: "http://100.104.231.93:3773/",
  wsBaseUrl: "ws://100.104.231.93:3773/",
};
const answered: Transport = async () => ({ kind: "answered", detail: "HTTP 200" });
const silent: Transport = async () => ({ kind: "no-answer" });
const refusedByOs: Transport = async () => ({
  kind: "failed",
  detail: "Could not connect to the server.",
});

describe("transportProbeVerdict", () => {
  it.each([
    [answered, answered, answered, "expo/fetch reached the server"],
    [silent, answered, answered, "Only expo/fetch failed"],
    [silent, refusedByOs, answered, "Both URLSession-based stacks failed"],
    [silent, silent, refusedByOs, "No stack in this app reached the server"],
  ])("names the layer that fails (%#)", async (expo, xhr, websocket, verdict) => {
    const report = await probeTransports(target, {
      "expo-fetch": expo,
      "rn-xhr": xhr,
      websocket,
    });
    expect(transportProbeVerdict(report)).toContain(verdict);
  });
});
