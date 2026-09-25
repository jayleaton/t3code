// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandCodeSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";
const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const decodeEvent = Schema.decodeUnknownEffect(ProviderAdapterV2Event);
const decodeCall = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      prompt: Schema.String,
      cwd: Schema.String,
      mcpServers: Schema.String,
      modSource: Schema.String,
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
const sessionId = prompt.endsWith('wrong-resume') ? 'wrong-session' : args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'native-' + process.env.INSTANCE;
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
// Mirrors the CLI: --print defaults to 100 model requests unless --max-turns raises it.
const requestBudget = args.includes('--max-turns') ? Number(args[args.indexOf('--max-turns') + 1]) : 100;
const requestsNeeded = prompt.endsWith('limit') ? Infinity : prompt.endsWith('long-run') ? 150 : 1;
emit({type:'result',subtype:requestsNeeded > requestBudget ? 'max_turns' : 'success',sessionId,finalText:'HelloDone',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}});
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

const layer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer);
const harness = Effect.gen(function* () {
  const { fs, cwd, make } = yield* setup;
  const adapter = yield* make();
  const modelSelection = { instanceId: ProviderInstanceId.make("one"), model: "default" };
  const runtimePolicy = {
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    cwd,
  };
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-test"),
    modelSelection,
    runtimePolicy,
  });
  const queue = yield* Stream.toQueue(runtime.events, { capacity: "unbounded" });
  let providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  let ordinal = 0;
  const start = (text: string, attachments: ReadonlyArray<ChatAttachment> = []) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      ordinal++;
      const appThread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project-test"),
        title: "Test",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      };
      yield* runtime.startTurn({
        appThread,
        threadId,
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-${ordinal}`),
        rootNodeId: NodeId.make(`node-${ordinal}`),
        providerThread,
        message: {
          messageId: MessageId.make(`message-${ordinal}`),
          text,
          attachments,
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
    });
  const take = Effect.gen(function* () {
    const events: ProviderAdapterV2Event[] = [];
    while (true) {
      const event = yield* Queue.take(queue);
      yield* decodeEvent(event);
      events.push(event);
      if (event.type === "provider_thread.updated") providerThread = event.providerThread;
      if (event.type === "turn.terminal") return events;
    }
  });
  const run = (text: string, attachments: ReadonlyArray<ChatAttachment> = []) =>
    start(text, attachments).pipe(Effect.andThen(take));
  const calls = fs.readFileString(`${cwd}/calls.jsonl`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => decodeCall(line)),
    ),
  );
  return { fs, cwd, adapter, runtime, start, take, run, calls, queue };
});

it.effect(
  "streams native V2 items, preserves permissions and resumes the environment-local conversation with attachments",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const image: ChatAttachment = {
        type: "image",
        id: "thread-commandcode-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const path = `${h.cwd}/attachments/${image.id}.png`;
      yield* h.fs.writeFile(path, new Uint8Array([137, 80, 78, 71]));
      const events = yield* h.run("Inspect this", [image]);
      assert.equal(events.at(-1)?.type, "turn.terminal");
      assert.include(
        events.filter((e) => e.type === "turn.terminal").map((e) => e.status),
        "completed",
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === "message.updated" && e.message.text === "HelloDone" && !e.message.streaming,
        ),
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "dynamic_tool" &&
            e.turnItem.status === "completed",
        ),
      );
      yield* h.run("Follow up");
      const calls = yield* h.calls;
      assert.deepEqual(calls[0]?.attachments, [{ path, bytes: [137, 80, 78, 71] }]);
      assert.include(calls[0]!.args, "dont-ask");
      assert.notInclude(calls[0]!.args, "--yolo");
      assert.include(calls[1]!.args, "--resume");
      assert.include(calls[1]!.args, "native-one");
      assert.equal(calls[0]!.cwd, yield* h.fs.realPath(h.cwd));
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("completes a turn that needs more model requests than the headless default", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const events = yield* h.run("long-run");
    assert.ok(events.some((e) => e.type === "turn.terminal" && e.status === "completed"));
  }).pipe(Effect.provide(layer), Effect.scoped),
);

for (const prompt of ["early-error", "bad-json", "limit"]) {
  it.effect(`terminalizes ${prompt} as a failed V2 turn`, () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const events = yield* h.run(prompt);
      assert.ok(events.some((e) => e.type === "turn.terminal" && e.status === "failed"));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

it.effect("rejects native session identity changes on resume", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.run("Hello");
    const events = yield* h.run("wrong-resume");
    assert.ok(events.some((e) => e.type === "turn.terminal" && e.status === "failed"));
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("interrupts the owned process and allows a subsequent turn", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.start("hang");
    let running;
    while (true) {
      const event = yield* Queue.take(h.queue);
      if (event.type === "provider_thread.updated") {
        running = event.providerThread;
        break;
      }
    }
    yield* h.runtime.interruptTurn({
      providerThread: running,
      providerTurnId: (yield* IdAllocatorV2).derive.providerTurn({
        driver: ProviderDriverKind.make("commandcode"),
        nativeTurnId: "one:attempt-1",
      }),
    });
    assert.ok(
      (yield* h.take).some((e) => e.type === "turn.terminal" && e.status === "interrupted"),
    );
    assert.ok(
      (yield* h.run("Again")).some((e) => e.type === "turn.terminal" && e.status === "completed"),
    );
  }).pipe(Effect.provide(layer), Effect.scoped),
);

for (const prompt of ["ready", "missing-mod", "mcp-failure"]) {
  it.effect(`keeps authorized MCP endpoints and fails closed for ${prompt}`, () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("test"),
        threadId,
        providerSessionId: "test-session",
        providerInstanceId: ProviderInstanceId.make("one"),
        endpoint: "http://127.0.0.1:43123/mcp",
        gatewayEndpoint: "http://127.0.0.1:43123/mcp/gateway",
        authorizationHeader: "Bearer test-only",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const h = yield* harness;
      const events = yield* h.run(prompt);
      assert.ok(
        events.some(
          (e) =>
            e.type === "turn.terminal" &&
            e.status === (prompt === "ready" ? "completed" : "failed"),
        ),
      );
      const calls = yield* h.calls;
      assert.include(calls[0]!.args, "--mod");
      assert.include(calls[0]!.mcpServers, "/mcp/gateway");
      assert.include(calls[0]!.modSource, "t3_mcp_ready");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

it.effect("projects valid compaction reports without inventing context window measurements", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const events = yield* h.run("compact");
    const items = events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "compaction"
        ? [event.turnItem]
        : [],
    );
    assert.deepEqual(
      items.map((item) => item.summary),
      ["Saved 41300 tokens", "Saved 200 tokens"],
    );
    assert.ok(
      items.every(
        (item) => item.beforeTokenCount === undefined && item.afterTokenCount === undefined,
      ),
    );
  }).pipe(Effect.provide(layer), Effect.scoped),
);
