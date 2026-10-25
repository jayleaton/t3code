import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

// A busy server releases its provider sessions within 5 s, so this is the
// backstop for a finalizer that never returns. It stays well inside a
// supervisor's stop budget (systemd waits 90 s before SIGKILL).
export const SERVER_SHUTDOWN_DEADLINE = Duration.seconds(10);

/**
 * Completes once this server begins shutting down. The default never completes,
 * for commands that hold the ownership lock without running a server.
 */
export const ShutdownStarted = Context.Reference<Effect.Effect<void>>(
  "t3/serverShutdown/ShutdownStarted",
  { defaultValue: () => Effect.never },
);

/**
 * Once shutdown begins, ends the process after the deadline even if a finalizer
 * hangs. A hung provider release or a stuck database write otherwise keeps the
 * ownership lock until someone kills the process, and when the desktop launcher
 * died first, nobody escalates to SIGKILL. The OS releases the lock on exit.
 */
export const enforceShutdownDeadline = Effect.fn("serverShutdown.enforceShutdownDeadline")(
  function* (
    started: Effect.Effect<void>,
    exit: (code: number) => void = (code) => process.exit(code),
  ) {
    // Detached: shutdown interrupts every fiber the server owns, and this one
    // has to outlive them.
    yield* started.pipe(
      Effect.andThen(Effect.sleep(SERVER_SHUTDOWN_DEADLINE)),
      Effect.andThen(
        Effect.logError("server shutdown exceeded its deadline; exiting without it", {
          deadlineMs: Duration.toMillis(SERVER_SHUTDOWN_DEADLINE),
        }),
      ),
      Effect.andThen(Effect.sync(() => exit(1))),
      Effect.forkDetach,
    );
  },
);
