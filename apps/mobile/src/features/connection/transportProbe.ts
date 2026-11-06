/**
 * Sends one request to an address through each native stack the app can use, so a failed add can
 * tell expo/fetch, React Native's own networking, and a raw WebSocket TCP connection apart.
 */
export type TransportName = "expo-fetch" | "rn-xhr" | "websocket";

export type TransportResult =
  /** The server answered at the HTTP level, including a refusal. */
  | { readonly kind: "answered"; readonly detail: string }
  /** The native stack reported an error before the budget ran out. */
  | { readonly kind: "failed"; readonly detail: string }
  /** Nothing came back within the budget. */
  | { readonly kind: "no-answer" };

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

const viaExpoFetch: Transport = async (target, budgetMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    // The global fetch is the one the add flow uses (expo/fetch unless EXPO_PUBLIC_USE_RN_FETCH).
    const response = await fetch(descriptorUrl(target.httpBaseUrl), { signal: controller.signal });
    return { kind: "answered", detail: `HTTP ${response.status}` };
  } catch (error) {
    return controller.signal.aborted
      ? { kind: "no-answer" }
      : { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

const viaXhr: Transport = (target, budgetMs) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = budgetMs;
    xhr.onload = () => resolve({ kind: "answered", detail: `HTTP ${xhr.status}` });
    xhr.ontimeout = () => resolve({ kind: "no-answer" });
    // React Native puts the native NSError text in responseText for a failed text request.
    xhr.onerror = () => resolve({ kind: "failed", detail: xhr.responseText || "error" });
    xhr.open("GET", descriptorUrl(target.httpBaseUrl));
    xhr.send();
  });

const viaWebSocket: Transport = (target, budgetMs) =>
  new Promise((resolve) => {
    // No ticket: a reachable server refuses the upgrade, which still proves TCP and HTTP got through.
    const socket = new WebSocket(new URL("/ws", target.wsBaseUrl).toString());
    const timer = setTimeout(() => {
      socket.close();
      resolve({ kind: "no-answer" });
    }, budgetMs);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.close();
      resolve({ kind: "answered", detail: "upgrade accepted" });
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      const reason = event.reason || `close ${event.code}`;
      resolve(
        /response code/i.test(reason)
          ? { kind: "answered", detail: reason }
          : { kind: "failed", detail: reason },
      );
    };
  });

export const NATIVE_TRANSPORTS: Readonly<Record<TransportName, Transport>> = {
  "expo-fetch": viaExpoFetch,
  "rn-xhr": viaXhr,
  websocket: viaWebSocket,
};

export type TransportProbeReport = Readonly<Record<TransportName, TransportOutcome>>;

export async function probeTransports(
  target: TransportProbeTarget,
  transports: Readonly<Record<TransportName, Transport>> = NATIVE_TRANSPORTS,
  budgetMs = 20_000,
): Promise<TransportProbeReport> {
  const run = async (transport: Transport): Promise<TransportOutcome> => {
    const startedAt = Date.now();
    const outcome = await transport(target, budgetMs);
    return { ...outcome, ms: Date.now() - startedAt };
  };
  const [expo, xhr, websocket] = await Promise.all([
    run(transports["expo-fetch"]),
    run(transports["rn-xhr"]),
    run(transports.websocket),
  ]);
  return { "expo-fetch": expo, "rn-xhr": xhr, websocket };
}

export function transportProbeVerdict(report: TransportProbeReport): string {
  const reached = (name: TransportName) => report[name].kind === "answered";
  if (reached("expo-fetch")) {
    return "expo/fetch reached the server, so this address works from the app right now.";
  }
  if (reached("rn-xhr")) {
    return "Only expo/fetch failed: React Native's networking reached the server, so the fault is in the expo/fetch stack.";
  }
  if (reached("websocket")) {
    return "Both URLSession-based stacks failed while a WebSocket's own TCP connection reached the server.";
  }
  return "No stack in this app reached the server, so packets are not getting through at the TCP level.";
}

const describe = (outcome: TransportOutcome) =>
  outcome.kind === "no-answer"
    ? `no answer after ${outcome.ms} ms`
    : `${outcome.kind} in ${outcome.ms} ms: ${outcome.detail}`;

export function formatTransportProbe(
  target: TransportProbeTarget,
  report: TransportProbeReport,
  at: Date,
): string {
  return [
    `Transport probe ${at.toISOString()} for ${target.httpBaseUrl}`,
    `expo/fetch: ${describe(report["expo-fetch"])}`,
    `React Native XHR: ${describe(report["rn-xhr"])}`,
    `WebSocket: ${describe(report.websocket)}`,
    transportProbeVerdict(report),
  ].join("\n");
}
