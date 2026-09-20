// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandCodeSettings,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);

const fixture = `
import { appendFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, prompt, instance: process.env.INSTANCE }) + '\\n');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (prompt.endsWith('early-error')) { emit({type:'result',subtype:'error',finalText:'',error:'Not authenticated'}); process.exit(3); }
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'native-' + process.env.INSTANCE;
emit({type:'event',event:{type:'run_start',sessionId}});
if (prompt.endsWith('hang')) { await new Promise(() => { setInterval(() => {}, 10000); }); }
if (prompt.endsWith('bad-json')) { process.stdout.write('bad json\\n'); process.exit(1); }
emit({type:'event',event:{type:'model_request_start',model:'model'}});
emit({type:'event',event:{type:'thinking_delta',delta:'Thinking'}});
emit({type:'event',event:{type:'text_delta',delta:'Hello'}});
emit({type:'event',event:{type:'model_request_end',model:'model',usage:{inputTokens:10,outputTokens:2}}});
emit({type:'event',event:{type:'tool_queued',toolCallId:'t1',toolName:'read_file',input:{path:'README.md'}}});
emit({type:'event',event:{type:'tool_completed',toolCallId:'t1',toolName:'read_file',result:[{type:'text',text:'contents'}]}});
emit({type:'event',event:{type:'text_delta',delta:'Done'}});
emit({type:'result',subtype:prompt.endsWith('limit')?'max_turns':'success',sessionId,finalText:'HelloDone',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}});
`;
const threadId = ThreadId.make("thread-commandcode");
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-commandcode-" });
  const binaryPath = yield* Effect.sync(() =>
    writeFakeCli({ directory: cwd, name: "commandcode", source: fixture }),
  );
  const make = (name = "one") =>
    makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
      instanceId: ProviderInstanceId.make(name),
      cwd,
      environment: { ...process.env, CALL_LOG: `${cwd}/calls.jsonl`, INSTANCE: name },
    });
  return { fs, cwd, make };
});
const takeTurn = (queue: Queue.Dequeue<ProviderRuntimeEvent, Cause.Done>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    while (true) {
      const event = yield* Queue.take(queue);
      yield* decodeEvent(event);
      events.push(event);
      if (event.type === "turn.completed") return events;
    }
  });

it.effect(
  "streams canonical events, resumes the exact session, and preserves agent instructions",
  () =>
    Effect.gen(function* () {
      const { fs, cwd, make } = yield* setup;
      const adapter = yield* make();
      const queue = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
      yield* adapter.startSession({
        threadId,
        runtimeMode: "approval-required",
        agentInstructions: "Follow the saved agent role.",
      });
      const first = yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection: { instanceId: ProviderInstanceId.make("one"), model: "kimi-k2.5" },
      });
      const events = yield* takeTurn(queue);
      assert.deepEqual(
        events.flatMap((e) =>
          e.type === "content.delta" && e.payload.streamKind === "assistant_text"
            ? [e.payload.delta]
            : [],
        ),
        ["Hello", "Done"],
      );
      assert.equal(
        events.filter(
          (e) => e.type === "item.completed" && e.payload.itemType === "dynamic_tool_call",
        ).length,
        1,
      );
      assert.deepEqual(first.resumeCursor, { sessionId: "native-one" });
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: first.resumeCursor,
      });
      yield* adapter.sendTurn({ threadId, input: "second", interactionMode: "plan" });
      yield* takeTurn(queue);
      const log = yield* fs.readFileString(`${cwd}/calls.jsonl`);
      assert.include(log, "Follow the saved agent role.");
      assert.include(log, '"--resume","native-one"');
      assert.include(log, '"--plan"');
      assert.notInclude(log, '"--yolo"');
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("interrupts a running process, rejects overlapping turns, and allows the next turn", () =>
  Effect.gen(function* () {
    const { make } = yield* setup;
    const adapter = yield* make();
    const queue = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
    yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
    const first = yield* adapter.sendTurn({ threadId, input: "hang" });
    const overlapping = yield* adapter.sendTurn({ threadId, input: "overlap" }).pipe(Effect.flip);
    assert.equal(overlapping._tag, "ProviderAdapterValidationError");
    yield* adapter.interruptTurn(threadId, first.turnId);
    const events = yield* takeTurn(queue);
    assert.equal(events.at(-1)?.type, "turn.completed");
    assert.include(
      events.map((event) => (event.type === "turn.completed" ? event.payload.state : "")),
      "interrupted",
    );
    yield* adapter.sendTurn({ threadId, input: "next" });
    yield* takeTurn(queue);
    yield* adapter.stopAll();
    assert.deepEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const prompt of ["early-error", "bad-json", "limit"]) {
  it.effect(`settles ${prompt} without leaving a running session`, () =>
    Effect.gen(function* () {
      const { make } = yield* setup;
      const adapter = yield* make();
      const queue = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, input: prompt }).pipe(Effect.ignore);
      const events = yield* takeTurn(queue);
      assert.include(
        events.map((event) => (event.type === "turn.completed" ? event.payload.state : "")),
        "failed",
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("isolates two provider instances and rejects invalid resume cursors", () =>
  Effect.gen(function* () {
    const { make } = yield* setup;
    const one = yield* make("one");
    const two = yield* make("two");
    const q1 = yield* Stream.toQueue(one.streamEvents, { capacity: "unbounded" });
    const q2 = yield* Stream.toQueue(two.streamEvents, { capacity: "unbounded" });
    for (const adapter of [one, two])
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
    const [a, b] = yield* Effect.all(
      [one.sendTurn({ threadId, input: "one" }), two.sendTurn({ threadId, input: "two" })],
      { concurrency: "unbounded" },
    );
    assert.notDeepEqual(a.resumeCursor, b.resumeCursor);
    yield* takeTurn(q1);
    yield* takeTurn(q2);
    yield* one.stopAll();
    assert.isTrue(yield* two.hasSession(threadId));
    const invalid = yield* one
      .startSession({ threadId, runtimeMode: "full-access", resumeCursor: { sessionId: "" } })
      .pipe(Effect.flip);
    assert.equal(invalid._tag, "ProviderAdapterValidationError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
