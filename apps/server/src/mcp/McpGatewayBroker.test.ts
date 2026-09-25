import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { MCP_GATEWAY_CALLER_META_KEY, make } from "./McpGatewayBroker.ts";

it.effect(
  "keeps identical MCP request IDs and notifications isolated across provider sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        expect(broker.available()).toBe(false);
        const ready = yield* Deferred.make<string>();
        const host = yield* broker.connect("desktop-auth-session").pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") return Deferred.succeed(ready, event.connectionId);
            if (event.type === "close") return Effect.void;
            return broker.respond("desktop-auth-session", {
              connectionId: event.connectionId,
              sessionId: event.sessionId,
              message: {
                jsonrpc: "2.0",
                id: event.message.id!,
                result: { sessionId: event.sessionId },
              },
            });
          }),
          Effect.forkScoped,
        );
        const connectionId = yield* Deferred.await(ready);
        const first = yield* broker.open("provider-a", {
          environmentId: "env",
          threadId: "thread-a",
        });
        const second = yield* broker.open("provider-b", {
          environmentId: "env",
          threadId: "thread-b",
        });
        const results = yield* Effect.all(
          [
            broker.send(first, "provider-a", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            broker.send(second, "provider-b", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.map((message) => message?.result)).toEqual([
          { sessionId: first },
          { sessionId: second },
        ]);
        expect(broker.lookup(first, "provider-b")).toBeUndefined();
        const forged = yield* Effect.result(
          broker.respond("unrelated-auth-session", {
            connectionId,
            sessionId: first,
            message: { jsonrpc: "2.0", method: "notifications/t3/events", params: {} },
          }),
        );
        expect(forged._tag).toBe("Failure");
        yield* broker.respond("desktop-auth-session", {
          connectionId,
          sessionId: second,
          message: { jsonrpc: "2.0", method: "notifications/t3/events", params: { sequence: 1 } },
        });
        expect(yield* Queue.take(broker.lookup(second, "provider-b")!.notifications)).toMatchObject(
          { params: { sequence: 1 } },
        );
        expect(yield* Queue.size(broker.lookup(first, "provider-a")!.notifications)).toBe(0);
        yield* Fiber.interrupt(host);
        expect(broker.available()).toBe(false);
        expect(broker.lookup(first, "provider-a")).toBeUndefined();
        expect(
          (yield* Effect.result(
            broker.open("provider-c", { environmentId: "env", threadId: "thread-c" }),
          ))._tag,
        ).toBe("Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "fails pending work on disconnect without moving it to another desktop or replaying it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const ready = yield* Deferred.make<void>();
        const received = yield* Deferred.make<void>();
        const host = yield* broker.connect("desktop").pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(ready, undefined)
              : Deferred.succeed(received, undefined),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const sessionId = yield* broker.open("provider", {
          environmentId: "env",
          threadId: "thread",
        });
        const request = yield* broker
          .send(sessionId, "provider", { jsonrpc: "2.0", id: "create", method: "tools/call" })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(received);
        yield* Fiber.interrupt(host);
        expect((yield* Fiber.join(request))._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("stamps tool calls with the calling thread, replacing any agent-supplied caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const ready = yield* Deferred.make<void>();
      yield* broker.connect("desktop").pipe(
        Stream.runForEach((event) => {
          if (event.type === "connected") return Deferred.succeed(ready, undefined);
          if (event.type === "close") return Effect.void;
          return broker.respond("desktop", {
            connectionId: event.connectionId,
            sessionId: event.sessionId,
            message: { jsonrpc: "2.0", id: event.message.id!, result: { echo: event.message } },
          });
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const sessionId = yield* broker.open("provider", {
        environmentId: "env-1",
        threadId: "parent",
      });
      const call = yield* broker.send(sessionId, "provider", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "t3_create_thread",
          arguments: { title: "Child" },
          _meta: {
            progressToken: 7,
            [MCP_GATEWAY_CALLER_META_KEY]: { environmentId: "env-1", threadId: "forged" },
          },
        },
      });
      expect(call?.result).toEqual({
        echo: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "t3_create_thread",
            arguments: { title: "Child" },
            _meta: {
              progressToken: 7,
              [MCP_GATEWAY_CALLER_META_KEY]: { environmentId: "env-1", threadId: "parent" },
            },
          },
        },
      });
      const list = yield* broker.send(sessionId, "provider", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      expect(list?.result).toEqual({ echo: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
