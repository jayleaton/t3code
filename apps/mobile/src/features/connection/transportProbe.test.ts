import { expect, it, vi } from "vite-plus/test";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

import {
  makeFetchTransport,
  makeWebSocketTransport,
  probeTransports,
  type Transport,
} from "./transportProbe";

const target = {
  httpBaseUrl: "http://100.104.231.93:3773/",
  wsBaseUrl: "ws://100.104.231.93:3773/",
};
const answered: Transport = async () => ({ kind: "answered", detail: "HTTP 200" });

it("keeps the other stacks' results when one transport throws", async () => {
  const report = await probeTransports(target, {
    fetch: () => {
      throw new TypeError("Network request failed");
    },
    "rn-xhr": answered,
    websocket: answered,
  });
  expect(report.fetch).toMatchObject({
    kind: "failed",
    detail: "transport threw: Network request failed",
  });
  expect(report["rn-xhr"].kind).toBe("answered");
  expect(report.websocket.kind).toBe("answered");
});

it("reports a body that never arrives after the headers", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => ({
    status: 200,
    text: () =>
      new Promise<string>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  })) as unknown as typeof fetch;
  const pending = makeFetchTransport(fetchFn)(target, 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toEqual({ kind: "no-answer", stage: "HTTP 200 headers, waiting for body" });
});

it("counts an upgrade refusal as an HTTP answer only when the native message names a status", async () => {
  const sockets: Array<FakeSocket> = [];
  class FakeSocket {
    onopen: (() => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    constructor() {
      sockets.push(this);
    }
    close() {}
  }
  const transport = makeWebSocketTransport(FakeSocket as unknown as typeof WebSocket);

  const refused = transport(target, 20_000);
  sockets[0]!.onerror?.({ message: "Received bad response code from server: 401." });
  sockets[0]!.onclose?.({ code: 1006, reason: "" });
  expect(await refused).toMatchObject({ kind: "answered" });

  const unreachable = transport(target, 20_000);
  sockets[1]!.onclose?.({ code: 1006, reason: "Could not connect to the server." });
  expect(await unreachable).toEqual({ kind: "failed", detail: "Could not connect to the server." });
});
