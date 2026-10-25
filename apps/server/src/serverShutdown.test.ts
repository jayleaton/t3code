import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import { enforceShutdownDeadline } from "./serverShutdown.ts";

it.effect("exits only once a started shutdown overruns its deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exitCode = yield* Deferred.make<number>();
    yield* enforceShutdownDeadline(Deferred.await(started), (code) => {
      Deferred.doneUnsafe(exitCode, Exit.succeed(code));
    });

    yield* TestClock.adjust("1 hour");
    assert.isFalse(yield* Deferred.isDone(exitCode));

    yield* Deferred.succeed(started, undefined);
    yield* TestClock.adjust("9 seconds");
    assert.isFalse(yield* Deferred.isDone(exitCode));
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Deferred.await(exitCode), 1);
  }),
);
