// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandCodeSettings,
  EnvironmentId,
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
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
const decodeCall = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      prompt: Schema.String,
      mcpServers: Schema.String,
      modSource: Schema.String,
      deviceMarker: Schema.optional(Schema.String),
      cwd: Schema.String,
      attachments: Schema.Array(
        Schema.Struct({ path: Schema.String, bytes: Schema.Array(Schema.Int) }),
      ),
    }),
  ),
);

const fixture = `
import { appendFileSync, readFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const attachmentPaths = prompt.includes('Attached files on this environment') ? JSON.parse(prompt.split('\\n').at(-1)) : [];
const attachments = attachmentPaths.map(path => ({path, bytes: [...readFileSync(path)]}));
appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, prompt, attachments, cwd: process.cwd(), instance: process.env.INSTANCE, mcpServers: process.env.T3_COMMANDCODE_MCP_SERVERS, modSource: args.includes("--mod") ? readFileSync(args[args.indexOf("--mod") + 1], "utf8") : "", deviceMarker: process.env.T3_TEST_DEVICE }) + '\\n');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (prompt.endsWith('early-error')) { emit({type:'result',subtype:'error',finalText:'',error:'Not authenticated'}); process.exit(3); }
if (args.includes('--mod') && !prompt.endsWith('missing-mod')) emit({type:'event',event:prompt.endsWith('mcp-failure')?{type:'t3_mcp_error',message:'MCP endpoint unavailable'}:{type:'t3_mcp_ready'}});
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'native-' + process.env.INSTANCE;
emit({type:'event',event:{type:'run_start',sessionId}});
if (prompt.endsWith('hang')) { await new Promise(() => { setInterval(() => {}, 10000); }); }
if (prompt.endsWith('bad-json')) { process.stdout.write('bad json\\n'); process.exit(1); }
if (prompt.endsWith('compact')) {
 emit({type:'event',event:{type:'compaction_start'}});
 emit({type:'event',event:{type:'compaction_done',tokensSaved:41300,totalTokensSaved:112000}});
 emit({type:'event',event:{type:'compaction_done',tokensSaved:200}});
 emit({type:'event',event:{type:'compaction_done',tokensSaved:0}});
 emit({type:'event',event:{type:'compaction_done',tokensSaved:-1}});
 emit({type:'event',event:{type:'compaction_done',tokensSaved:'invalid'}});
}
emit({type:'event',event:{type:'thinking_delta',delta:'Thinking'}});
emit({type:'event',event:{type:'text_delta',delta:'Hello'}});
emit({type:'event',event:{type:'tool_queued',toolCallId:'t1',toolName:'read_file',input:{path:'README.md'}}});
emit({type:'event',event:{type:'tool_completed',toolCallId:'t1',toolName:'read_file',result:[{type:'text',text:'contents'}]}});
emit({type:'event',event:{type:'text_delta',delta:'Done'}});
emit({type:'result',subtype:prompt.endsWith('limit')?'max_turns':'success',sessionId,finalText:'HelloDone',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}});
`;
const threadId = ThreadId.make("thread-commandcode");
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-commandcode-" });
  yield* fs.makeDirectory(`${cwd}/attachments`);
  const binaryPath = yield* Effect.sync(() =>
    writeFakeCli({ directory: cwd, name: "commandcode", source: fixture }),
  );
  const make = (name = "one") =>
    makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
      instanceId: ProviderInstanceId.make(name),
      cwd,
      attachmentsDir: `${cwd}/attachments`,
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

it.effect("passes stored images and files to headless turns through environment-local paths", () =>
  Effect.gen(function* () {
    const { fs, cwd, make } = yield* setup;
    const image = {
      type: "image" as const,
      id: "thread-commandcode-12345678-1234-1234-1234-123456789abc",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const file = {
      type: "file" as const,
      id: "thread-commandcode-12345678-1234-1234-1234-123456789abc-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const imagePath = `${cwd}/attachments/${image.id}.png`;
    const filePath = `${cwd}/attachments/${file.id}.txt`;
    const bytes = [137, 80, 78, 71];
    yield* fs.writeFile(imagePath, new Uint8Array(bytes));
    yield* fs.writeFileString(filePath, "notes");
    yield* fs.makeDirectory(`${cwd}/project`);
    const adapter = yield* make();
    const queue = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
    yield* adapter.startSession({
      threadId,
      cwd: `${cwd}/project`,
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId, attachments: [image] });
    yield* takeTurn(queue);
    yield* adapter.sendTurn({ threadId, input: "Compare these", attachments: [image, file] });
    yield* takeTurn(queue);
    yield* adapter.sendTurn({ threadId, input: "Use the earlier image again" });
    yield* takeTurn(queue);
    const calls = (yield* fs.readFileString(`${cwd}/calls.jsonl`))
      .trim()
      .split("\n")
      .map((line) => decodeCall(line));
    assert.lengthOf(calls, 3);
    assert.deepEqual(calls[0]!.attachments, [{ path: imagePath, bytes }]);
    assert.deepEqual(calls[1]!.attachments, [
      { path: imagePath, bytes },
      { path: filePath, bytes: [...new TextEncoder().encode("notes")] },
    ]);
    assert.include(calls[1]!.prompt, "Compare these");
    assert.include(calls[0]!.prompt, "use read_file");
    assert.notInclude(calls[0]!.prompt, "undefined");
    const projectPath = yield* fs.realPath(`${cwd}/project`);
    for (const call of calls) {
      assert.equal(call.cwd, projectPath);
      assert.equal(call.args[call.args.indexOf("--add-dir") + 1], `${cwd}/attachments`);
      assert.include(call.args, "dont-ask");
      assert.notInclude(call.args, "--yolo");
    }
    assert.include(calls[2]!.args, "--resume");
    assert.isTrue(yield* fs.exists(imagePath));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const id of ["../outside", "thread-commandcode-12345678-1234-1234-1234-123456789abc"]) {
  it.effect(`rejects an unavailable attachment before spawning: ${id}`, () =>
    Effect.gen(function* () {
      const { fs, cwd, make } = yield* setup;
      const adapter = yield* make();
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const error = yield* adapter
        .sendTurn({
          threadId,
          attachments: [
            { type: "image", id, name: "missing.png", mimeType: "image/png", sizeBytes: 1 },
          ],
        })
        .pipe(Effect.flip);
      assert.equal(
        error._tag,
        id.startsWith("..") ? "ProviderAdapterValidationError" : "ProviderAdapterRequestError",
      );
      assert.isFalse(yield* fs.exists(`${cwd}/calls.jsonl`));
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

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
      assert.include(log, "<tool_availability>");
      assert.notInclude(log, "<pull_request_linking>");
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
      if (prompt === "limit") {
        assert.include(
          events
            .flatMap((event) =>
              event.type === "turn.completed" ? [event.payload.errorMessage ?? ""] : [],
            )
            .join("\n"),
          "The session is saved; send a follow-up to continue.",
        );
        const resumed = yield* adapter.sendTurn({ threadId, input: "continue" });
        assert.deepEqual(resumed.resumeCursor, { sessionId: "native-one" });
        const continuedEvents = yield* takeTurn(queue);
        assert.include(
          continuedEvents.map((event) =>
            event.type === "turn.completed" ? event.payload.state : "",
          ),
          "completed",
        );
      }
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

it.effect(
  "injects thread-scoped MCP tools on initial and resumed turns without persisting credentials",
  () =>
    Effect.gen(function* () {
      const { fs, cwd, make } = yield* setup;
      const config = {
        environmentId: EnvironmentId.make("local"),
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("one"),
        endpoint: "http://localhost:9999/mcp",
        gatewayEndpoint: "http://localhost:9999/mcp/gateway",
        authorizationHeader: "Bearer first-thread-token",
        capabilities: new Set(["gateway", "device"]),
        agentDeviceEnvironment: { T3_TEST_DEVICE: "available" },
      };
      McpProviderSession.setMcpProviderSession(config);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const adapter = yield* make();
      const queue = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "List skills" });
      yield* takeTurn(queue);
      McpProviderSession.setMcpProviderSession({
        ...config,
        authorizationHeader: "Bearer renewed-thread-token",
      });
      yield* adapter.sendTurn({ threadId, input: "List skills again" });
      yield* takeTurn(queue);
      const calls = (yield* fs.readFileString(`${cwd}/calls.jsonl`))
        .trim()
        .split("\n")
        .map((line) => decodeCall(line));
      assert.lengthOf(calls, 2);
      for (const call of calls) {
        assert.include(call.args, "--mod");
        assert.include(call.mcpServers, "t3-code");
        assert.include(call.mcpServers, "t3-gateway");
        assert.notInclude(call.prompt, "does not inject");
        assert.include(call.prompt, "link_pull_request");
        assert.notInclude(call.modSource, "thread-token");
        assert.notInclude(call.prompt, "thread-token");
        assert.equal(call.deviceMarker, "available");
        assert.isFalse(yield* fs.exists(call.args[call.args.indexOf("--mod") + 1]!));
      }
      assert.include(calls[0]!.mcpServers, "first-thread-token");
      assert.include(calls[1]!.mcpServers, "renewed-thread-token");
      assert.include(calls[1]!.args, "--resume");
      assert.isFalse(yield* fs.exists(`${cwd}/.mcp.json`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const prompt of ["mcp-failure", "missing-mod"]) {
  it.effect(`fails clearly when T3 MCP cannot load (${prompt})`, () =>
    Effect.gen(function* () {
      const { make } = yield* setup;
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("local"),
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("one"),
        endpoint: "http://localhost:9999/mcp",
        authorizationHeader: "Bearer test-token",
        capabilities: new Set(),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const adapter = yield* make();
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const failure = yield* adapter.sendTurn({ threadId, input: prompt }).pipe(Effect.flip);
      assert.instanceOf(failure, Error);
      assert.include(
        String(failure),
        prompt === "mcp-failure" ? "MCP endpoint unavailable" : "did not load the T3 MCP tools",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("reports automatic compaction savings and continues the same turn", () =>
  Effect.gen(function* () {
    const { make } = yield* setup;
    const adapter = yield* make();
    const queue = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
    yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "compact" });
    const events = yield* takeTurn(queue);
    const compacted = events.filter((event) => event.type === "thread.state.changed");
    assert.deepEqual(
      compacted.map((event) => event.payload),
      [
        { state: "compacted", detail: "Saved 41300 tokens (112000 total this session)." },
        { state: "compacted", detail: "Saved 200 tokens." },
      ],
    );
    assert.isTrue(compacted.every((event) => event.turnId === events.at(-1)?.turnId));
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    assert.isTrue(
      events.some((event) => event.type === "content.delta" && event.payload.delta === "Done"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
