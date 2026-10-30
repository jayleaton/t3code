import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  inspectTailscaleServePort,
  selectTailscaleServePort,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const LastServePort = Schema.Struct({ servePort: Schema.Int });
const LastServePortJson = Schema.fromJsonString(LastServePort);
const decodeLastServePort = Schema.decodeUnknownEffect(LastServePortJson);
const encodeLastServePort = Schema.encodeEffect(LastServePortJson);

const lastServePortPath = Effect.fnUntraced(function* (stateDir: string) {
  return (yield* Path.Path).join(stateDir, "tailscale-serve.json");
});

/** The Serve port this server last published on, so a restart keeps its tailnet URL. */
const readLastTailscaleServePort = Effect.fn("TailscaleServePort.readLast")(
  function* (stateDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(yield* lastServePortPath(stateDir));
    return (yield* decodeLastServePort(raw)).servePort;
  },
  Effect.orElseSucceed(() => null),
);

export const writeLastTailscaleServePort = Effect.fn("TailscaleServePort.writeLast")(function* (
  stateDir: string,
  servePort: number,
) {
  yield* writeFileStringAtomically({
    filePath: yield* lastServePortPath(stateDir),
    contents: `${yield* encodeLastServePort({ servePort })}\n`,
  });
});

/** The port route checks should watch when nothing has published yet: pinned, last used, or 443. */
export const expectedTailscaleServePort = Effect.fn("TailscaleServePort.expected")(
  function* (input: { readonly pinnedPort: number | undefined; readonly stateDir: string }) {
    return (
      input.pinnedPort ??
      (yield* readLastTailscaleServePort(input.stateDir)) ??
      DEFAULT_TAILSCALE_SERVE_PORT
    );
  },
);

/**
 * Where this server should publish. A pinned port is only inspected, so the caller can
 * refuse when it serves another live server; otherwise the last port used comes first.
 */
export const chooseTailscaleServePort = Effect.fn("TailscaleServePort.choose")(function* (input: {
  readonly pinnedPort: number | undefined;
  readonly stateDir: string;
  readonly localPort: number;
  readonly localHost?: string;
}) {
  const local = {
    localPort: input.localPort,
    ...(input.localHost === undefined ? {} : { localHost: input.localHost }),
  };
  if (input.pinnedPort !== undefined) {
    const ownership = yield* inspectTailscaleServePort({ ...local, servePort: input.pinnedPort });
    return { servePort: input.pinnedPort, ownership };
  }
  const lastPort = yield* readLastTailscaleServePort(input.stateDir);
  return yield* selectTailscaleServePort({
    ...local,
    preferredPorts: lastPort === null ? [] : [lastPort],
  });
});
