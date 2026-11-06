import { fetch as expoFetch } from "expo/fetch";

/**
 * Sends the descriptor request to an address through each native stack the app can use, so a
 * failed add records how each one behaved. It observes; it does not name a root cause.
 */
export type TransportName = "fetch" | "rn-xhr" | "websocket";

export type TransportResult =
  /** The server answered with an explicit HTTP status (and, for requests, the body arrived). */
  | { readonly kind: "answered"; readonly detail: string }
  /** The stack reported an error, or the transport threw, before the budget ran out. */
  | { readonly kind: "failed"; readonly detail: string }
  /** Nothing came back within the budget; `stage` says how far the request got. */
  | { readonly kind: "no-answer"; readonly stage: string };

export type TransportOutcome = TransportResult & { readonly ms: number };

export interface TransportProbeTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type Transport = (
  target: TransportProbeTarget,
  budgetMs: number,
) => Promise<TransportResult>;

const descriptorUrl = (httpBaseUrl: string) =>
  new URL("/.well-known/t3/environment", httpBaseUrl).toString();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads headers, then the whole body, under one abort budget, like discovery does. */
export const makeFetchTransport =
  (fetchFn: typeof globalThis.fetch): Transport =>
  async (target, budgetMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let stage = "waiting for headers";
    try {
      const response = await fetchFn(descriptorUrl(target.httpBaseUrl), {
        signal: controller.signal,
      });
      stage = `HTTP ${response.status} headers, waiting for body`;
      const body = await response.text();
      return { kind: "answered", detail: `HTTP ${response.status}, body ${body.length} chars` };
    } catch (error) {
      return controller.signal.aborted
        ? { kind: "no-answer", stage }
        : { kind: "failed", detail: `${stage}: ${message(error)}` };
    } finally {
      clearTimeout(timer);
    }
  };

const viaXhr: Transport = (target, budgetMs) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const settle = (result: TransportResult) => {
      clearTimeout(guard);
      xhr.onload = xhr.onerror = xhr.ontimeout = null;
      resolve(result);
    };
    // xhr.timeout covers the native request; the guard also bounds a request that never reports.
    const guard = setTimeout(() => {
      xhr.abort();
      settle({ kind: "no-answer", stage: `readyState ${xhr.readyState}` });
    }, budgetMs + 1_000);
    xhr.timeout = budgetMs;
    xhr.onload = () =>
      settle({
        kind: "answered",
        detail: `HTTP ${xhr.status}, body ${xhr.responseText.length} chars`,
      });
    xhr.ontimeout = () => settle({ kind: "no-answer", stage: `readyState ${xhr.readyState}` });
    // React Native puts the native NSError text in responseText for a failed text request.
    xhr.onerror = () => settle({ kind: "failed", detail: xhr.responseText || "error event" });
    xhr.open("GET", descriptorUrl(target.httpBaseUrl));
    xhr.send();
  });

/** An upgrade refusal names its status; only then did an HTTP answer arrive. */
export function webSocketFailureResult(nativeMessage: string): TransportResult {
  const status = /response code[^0-9]*(\d{3})/i.exec(nativeMessage)?.[1];
  return status
    ? { kind: "answered", detail: `HTTP ${status} on upgrade (${nativeMessage})` }
    : { kind: "failed", detail: nativeMessage };
}

export const makeWebSocketTransport =
  (WebSocketCtor: typeof WebSocket): Transport =>
  (target, budgetMs) =>
    new Promise((resolve) => {
      // No ticket: a reachable server refuses the upgrade with a status, which is the answer we want.
      const socket = new WebSocketCtor(new URL("/ws", target.wsBaseUrl).toString());
      let nativeMessage: string | null = null;
      const settle = (result: TransportResult) => {
        clearTimeout(timer);
        socket.onopen = socket.onerror = socket.onclose = null;
        socket.close();
        resolve(result);
      };
      const timer = setTimeout(() => settle({ kind: "no-answer", stage: "upgrade" }), budgetMs);
      socket.onopen = () => settle({ kind: "answered", detail: "upgrade accepted" });
      // React Native versions differ on whether the native message rides the error or the close event.
      socket.onerror = (event) => {
        const text = (event as { readonly message?: unknown }).message;
        if (typeof text === "string" && text.length > 0) nativeMessage = text;
      };
      socket.onclose = (event) =>
        settle(webSocketFailureResult(event.reason || nativeMessage || `close ${event.code}`));
    });

/** Which implementation backs the global fetch the add flow uses. */
export function fetchImplementation(): string {
  const flag = process.env.EXPO_PUBLIC_USE_RN_FETCH;
  const kind = fetch === expoFetch ? "expo/fetch" : "not expo/fetch";
  return `${kind} (EXPO_PUBLIC_USE_RN_FETCH=${flag ?? "unset"})`;
}

export const NATIVE_TRANSPORTS: Readonly<Record<TransportName, Transport>> = {
  fetch: makeFetchTransport((input, init) => fetch(input, init)),
  "rn-xhr": viaXhr,
  websocket: (target, budgetMs) => makeWebSocketTransport(WebSocket)(target, budgetMs),
};

export type TransportProbeReport = Readonly<Record<TransportName, TransportOutcome>>;

export async function probeTransports(
  target: TransportProbeTarget,
  transports: Readonly<Record<TransportName, Transport>> = NATIVE_TRANSPORTS,
  budgetMs = 20_000,
): Promise<TransportProbeReport> {
  const run = async (transport: Transport): Promise<TransportOutcome> => {
    const startedAt = Date.now();
    let result: TransportResult;
    try {
      result = await transport(target, budgetMs);
    } catch (error) {
      result = { kind: "failed", detail: `transport threw: ${message(error)}` };
    }
    return { ...result, ms: Date.now() - startedAt };
  };
  const [fetchOutcome, xhr, websocket] = await Promise.all([
    run(transports.fetch),
    run(transports["rn-xhr"]),
    run(transports.websocket),
  ]);
  return { fetch: fetchOutcome, "rn-xhr": xhr, websocket };
}

const TRANSPORT_NAMES: ReadonlyArray<TransportName> = ["fetch", "rn-xhr", "websocket"];

export function transportProbeObservation(report: TransportProbeReport): string {
  const answered = TRANSPORT_NAMES.filter((name) => report[name].kind === "answered");
  const unanswered = TRANSPORT_NAMES.filter((name) => report[name].kind !== "answered");
  if (unanswered.length === 0) return "All three stacks got an HTTP answer from this address.";
  if (answered.length === 0) {
    return "None of the three stacks got an HTTP answer. That alone does not say whether DNS, routing, TCP, TLS or the app stopped it; the native errors above are the evidence.";
  }
  return `HTTP answer: ${answered.join(", ")}. No HTTP answer: ${unanswered.join(", ")}. The stacks behaved differently here; that difference is not yet a root cause.`;
}

const describe = (outcome: TransportOutcome) =>
  outcome.kind === "no-answer"
    ? `no answer after ${outcome.ms} ms (${outcome.stage})`
    : `${outcome.kind} in ${outcome.ms} ms: ${outcome.detail}`;

export function formatTransportProbe(
  target: TransportProbeTarget,
  report: TransportProbeReport,
  at: Date,
): string {
  return [
    `Transport probe ${at.toISOString()} for ${target.httpBaseUrl}`,
    `fetch [${fetchImplementation()}]: ${describe(report.fetch)}`,
    `React Native XHR: ${describe(report["rn-xhr"])}`,
    `WebSocket: ${describe(report.websocket)}`,
    transportProbeObservation(report),
  ].join("\n");
}
