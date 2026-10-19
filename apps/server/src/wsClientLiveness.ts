import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { RpcServer } from "effect/rpc";

// Clients ping every 5 seconds. Hidden browser tabs can be throttled to one
// timer per minute, so silence has to outlast that before it means "gone".
const CLIENT_SILENCE_LIMIT = Duration.seconds(90);
// A reading client drains the socket at some rate, however slow. Bytes queued
// with no progress mean the peer stopped reading, as a suspended iOS app does.
const SEND_STALL_LIMIT = Duration.seconds(30);
const CHECK_INTERVAL = Duration.seconds(5);

export interface TransportProgress {
  /** Bytes written by the server that the kernel has not accepted yet. */
  readonly pendingBytes: number;
  /** Bytes the kernel has accepted so far. */
  readonly bytesWritten: number;
}

export type ClientUnresponsiveReason = "client-silent" | "send-stalled";

/**
 * Watches one WebSocket RPC connection for a peer that is gone without closing.
 *
 * A suspended mobile app keeps its TCP connection open: the phone's kernel
 * still acknowledges and advertises a zero window, so neither TCP nor the RPC
 * layer notices, and on resume the app reuses a socket wedged behind a stale
 * backlog. `awaitUnresponsive` completes once the client has sent nothing for
 * {@link CLIENT_SILENCE_LIMIT} or the send queue has not moved for
 * {@link SEND_STALL_LIMIT}, so the caller can reset the connection.
 */
export const make = (readProgress: () => TransportProgress) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    let lastHeardAt = clock.currentTimeMillisUnsafe();
    let lastProgressAt = lastHeardAt;
    let lastBytesWritten = readProgress().bytesWritten;

    const observe = (protocol: RpcServer.Protocol["Service"]): RpcServer.Protocol["Service"] => ({
      ...protocol,
      run: (write) =>
        protocol.run((clientId, message) => {
          lastHeardAt = clock.currentTimeMillisUnsafe();
          return write(clientId, message);
        }),
    });

    const silenceMs = Duration.toMillis(CLIENT_SILENCE_LIMIT);
    const stallMs = Duration.toMillis(SEND_STALL_LIMIT);
    const check = Effect.sync((): ClientUnresponsiveReason | undefined => {
      const now = clock.currentTimeMillisUnsafe();
      const { pendingBytes, bytesWritten } = readProgress();
      if (pendingBytes === 0 || bytesWritten !== lastBytesWritten) {
        lastProgressAt = now;
        lastBytesWritten = bytesWritten;
      }
      if (now - lastHeardAt >= silenceMs) return "client-silent";
      if (now - lastProgressAt >= stallMs) return "send-stalled";
      return undefined;
    });

    const awaitUnresponsive = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(CHECK_INTERVAL);
        const reason = yield* check;
        if (reason !== undefined) return reason;
      }
    });

    return { observe, awaitUnresponsive } as const;
  });
