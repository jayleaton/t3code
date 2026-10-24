import { ExecutionEnvironmentDescriptor, type EnvironmentId } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  readTailscaleServeHandlers,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

// A route is only re-pointed by something else on this machine (a second
// server, a hand-run `tailscale serve`), so a slow recheck is enough to name
// the cause while it is still running.
const RECHECK_INTERVAL = Duration.minutes(10);
const PROBE_TIMEOUT = Duration.seconds(5);

export type TailnetRouteState =
  | { readonly _tag: "unpublished" }
  | { readonly _tag: "reaches-this-server"; readonly url: string }
  | {
      readonly _tag: "misrouted";
      readonly url: string;
      readonly target: string;
      readonly observed: "other-environment" | "not-a-t3-server" | "unreachable";
    };

const probeEnvironmentId = Effect.fn("TailnetRouteCheck.probeEnvironmentId")(
  function* (url: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(new URL("/.well-known/t3/environment", url).toString());
    // Tailscale answers 502 itself when its target is gone.
    if (response.status >= 500) return Option.none<Option.Option<EnvironmentId>>();
    const descriptor = yield* HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)(
      response,
    ).pipe(Effect.option);
    return Option.some(Option.map(descriptor, (value) => value.environmentId));
  },
  Effect.scoped,
  Effect.timeoutOption(PROBE_TIMEOUT),
  Effect.map(Option.flatten),
  Effect.orElseSucceed(() => Option.none<Option.Option<EnvironmentId>>()),
);

/**
 * Whether this machine's tailnet HTTPS route on `servePort` reaches this server. Remote
 * clients pair against that URL, so a route re-pointed elsewhere strands every one of them.
 */
const checkTailnetRoute = Effect.fn("TailnetRouteCheck.check")(function* (input: {
  readonly servePort: number;
  readonly environmentId: EnvironmentId;
}) {
  const status = yield* readTailscaleStatus;
  const handler = (yield* readTailscaleServeHandlers).find(
    (candidate) => candidate.servePort === input.servePort,
  );
  if (status.magicDnsName === null || handler === undefined) {
    return { _tag: "unpublished" } as TailnetRouteState;
  }
  const url = buildTailscaleHttpsBaseUrl({
    magicDnsName: status.magicDnsName,
    servePort: input.servePort,
  });
  const probed = yield* probeEnvironmentId(url);
  if (Option.isSome(probed) && Option.contains(probed.value, input.environmentId)) {
    return { _tag: "reaches-this-server", url } as TailnetRouteState;
  }
  return {
    _tag: "misrouted",
    url,
    target: handler.target,
    observed: Option.isNone(probed)
      ? "unreachable"
      : Option.isSome(probed.value)
        ? "other-environment"
        : "not-a-t3-server",
  } as TailnetRouteState;
});

const OBSERVED_TEXT = {
  "other-environment": "a different T3 environment answers there",
  "not-a-t3-server": "something other than T3 answers there",
  unreachable: "nothing answers there (remote clients get 502 or time out)",
} as const;

/**
 * Checks at startup and every few minutes, logging only when the route starts or stops
 * reaching this server. Machines without Tailscale, or without a route on that port, stay quiet.
 */
export const watchTailnetRoute = Effect.fn("TailnetRouteCheck.watch")(function* (input: {
  readonly servePort: number;
  readonly localPort: number;
  readonly environmentId: EnvironmentId;
}) {
  let wasMisrouted = false;
  const check = checkTailnetRoute(input).pipe(
    Effect.flatMap((state) => {
      if (state._tag === "misrouted") {
        if (wasMisrouted) return Effect.void;
        wasMisrouted = true;
        return Effect.logWarning(
          `Tailnet route ${state.url} forwards to ${state.target}, not to this server: ${OBSERVED_TEXT[state.observed]}. If remote clients should reach this server there, run \`tailscale serve --bg --https=${String(input.servePort)} http://127.0.0.1:${String(input.localPort)}\`.`,
        );
      }
      if (!wasMisrouted) return Effect.void;
      wasMisrouted = false;
      return Effect.logInfo("Tailnet route reaches this server again", {
        servePort: input.servePort,
      });
    }),
    Effect.catch(() => Effect.void),
  );
  yield* check;
  return yield* Effect.sleep(RECHECK_INTERVAL).pipe(Effect.andThen(check), Effect.forever);
});
