import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { AgentSkill, type ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import { syncAgentLibraryBeforeUse } from "../operations/agentLibrary.ts";
import { performAgentHandoff } from "./handoff.ts";
import {
  RuntimeRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ScheduledTaskError,
  ScheduledTaskId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  McpGatewayProfile,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellStreamItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import {
  interruptThreadTurn,
  stopThreadSession,
  respondToThreadApproval,
  startThreadTurn,
  settleThread,
  unsettleThread,
} from "../operations/commands.ts";
import { request, runStream, subscribe } from "../rpc/client.ts";
import type {
  GatewayDevice,
  GatewayProfile,
  GatewayProfileModelSelection,
  GatewayRuntimeEvent,
  GatewayRuntimeEventSource,
  GatewayRuntimePort,
  GatewayThreadExecutionState,
} from "./port.ts";

export interface GatewayEffectRuntime {
  runPromise<A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>): Promise<A>;
}

export function createGatewayRuntimePortFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto>,
  openThread?: (environmentId: string, threadId: string) => Promise<void>,
  openAgents?: () => Promise<void>,
): GatewayRuntimePort {
  return createGatewayRuntimePort(
    {
      runPromise: (effect) => Effect.runPromiseWith(context)(effect),
    },
    openThread,
    openAgents,
  );
}

function targetKind(tag: string): string {
  return tag.replace(/ConnectionTarget$/, "").toLowerCase();
}

const shellSnapshot = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry
      .run(
        environmentId,
        subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.map(
            (item) =>
              (Option.getOrThrow(item) as { snapshot: OrchestrationV2ShellSnapshot }).snapshot,
          ),
        ),
      )
      .pipe(Effect.timeout("20 seconds"));
  });

const threadSnapshot = (environmentId: EnvironmentId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry
      .run(
        environmentId,
        subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
          threadId,
          acceptBoundedSnapshot: true,
        }).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.map((item) => Option.getOrThrow(item).projection),
        ),
      )
      .pipe(Effect.timeout("20 seconds"));
  });

const listGatewayDevices = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const { clients } = yield* registry.run(environmentId, request(WS_METHODS.clientsList, {}));
    return clients.map((client): GatewayDevice => ({
      deviceId: client.clientId,
      label: client.label,
      kind: client.clientKind === "desktop-renderer" ? "desktop" : client.clientKind,
      ...(client.platform === undefined ? {} : { platform: client.platform }),
      visible: client.visible,
      focused: client.focused,
      connectedAt: DateTime.formatIso(client.connectedAt),
    }));
  });

/**
 * The model and modes a scheduled task stores for its agent profile, or why the profile cannot
 * run tasks. Runs still relaunch with the profile's latest revision; this is the task's snapshot.
 */
export function resolveScheduledTaskProfileRouting(
  profiles: ReadonlyArray<McpGatewayProfile>,
  profileId: string,
  providers: ReadonlyArray<ServerProvider>,
) {
  const profile = profiles.find((candidate) => candidate.profileId === profileId);
  if (profile === undefined) return `Agent ${profileId} was not found.`;
  if (profile.runtimeMode === "read-only") {
    return `Agent ${profile.name} is read-only and cannot run scheduled tasks.`;
  }
  const selection = resolveGatewayProfileModelSelection(profile, providers);
  if (selection === undefined) return `Agent ${profile.name} has no available provider and model.`;
  return {
    profileId,
    modelSelection: {
      model: selection.model,
      instanceId: ProviderInstanceId.make(selection.instanceId),
      ...(selection.options === undefined ? {} : { options: selection.options }),
    },
    runtimeMode: profile.runtimeMode,
    interactionMode: profile.interactionMode,
  };
}

/** A task created without a title is named after the first line of its prompt. */
export function defaultScheduledTaskTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0]!.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

/** Accepts a deviceId, or a device label when exactly one connected device carries it. */
export function resolveGatewayDevice(
  devices: ReadonlyArray<GatewayDevice>,
  device: string,
): GatewayDevice {
  const byId = devices.find((candidate) => candidate.deviceId === device);
  if (byId) return byId;
  const wanted = device.trim().toLowerCase();
  const byLabel = devices.filter((candidate) => candidate.label.toLowerCase() === wanted);
  if (byLabel.length === 1) return byLabel[0]!;
  const available = devices.map((candidate) => `${candidate.label} (${candidate.deviceId})`);
  throw new Error(
    byLabel.length > 1
      ? `Several devices are named "${device}"; pass a deviceId: ${available.join(", ")}.`
      : `Device "${device}" is not connected. Connected devices: ${available.join(", ") || "none"}.`,
  );
}

/**
 * Resolves persisted readable profile labels against a live provider catalog.
 * Exactly one enabled/available provider + model pair must match; duplicate
 * labels stay unresolved rather than routing a thread ambiguously. Legacy
 * profiles without labels validate their persisted routing snapshot against
 * the same live catalog.
 */
export function resolveGatewayProfileModelSelection(
  profile: Pick<GatewayProfile, "providerLabel" | "modelLabel" | "modelSelection">,
  providers: ReadonlyArray<ServerProvider>,
): GatewayProfileModelSelection | undefined {
  if (profile.providerLabel === undefined || profile.modelLabel === undefined) {
    const selection = profile.modelSelection;
    if (selection === undefined) return undefined;
    const matches = providers.filter(
      (provider) =>
        provider.instanceId === selection.instanceId &&
        provider.enabled &&
        provider.status === "ready" &&
        provider.availability !== "unavailable" &&
        provider.models.some((model) => model.slug === selection.model),
    );
    return matches.length === 1 ? selection : undefined;
  }
  const matches = providers.flatMap((provider) => {
    const providerLabel = provider.displayName?.trim() || provider.driver;
    if (
      !provider.enabled ||
      provider.status !== "ready" ||
      provider.availability === "unavailable" ||
      providerLabel !== profile.providerLabel
    ) {
      return [];
    }
    return provider.models
      .filter((model) => model.slug === profile.modelLabel || model.name === profile.modelLabel)
      .map((model) => ({ instanceId: provider.instanceId, model: model.slug }));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function iso(value: DateTime.Utc | null | undefined): string | null {
  return value == null ? null : DateTime.formatIso(value);
}

function gatewayProjectProjection(project: OrchestrationV2ShellSnapshot["projects"][number]) {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function gatewayStatusFromThread(
  thread: Pick<OrchestrationV2ThreadShell, "status" | "pendingRuntimeRequest">,
): GatewayThreadExecutionState {
  if (thread.pendingRuntimeRequest)
    return thread.pendingRuntimeRequest.kind === "user_input"
      ? "waiting-input"
      : "waiting-approval";
  if (thread.status === "preparing" || thread.status === "starting") return "queued";
  if (thread.status === "cancelled" || thread.status === "rolled_back") return "stopped";
  if (thread.status === "waiting") return "running";
  return thread.status;
}

function profileAssociation(
  profile: import("@t3tools/contracts").ThreadProfileSnapshot | undefined,
) {
  if (!profile) return undefined;
  const { systemPrompt: _instructions, skills: _skills, ...association } = profile;
  return association;
}

function gatewayThreadShellProjection(thread: OrchestrationV2ThreadShell) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    profileSnapshot: profileAssociation(thread.profileSnapshot),
    parentThreadId: thread.parentThreadId ?? null,
    settledAt: iso(thread.settledAt),
    status: gatewayStatusFromThread(thread),
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null && thread.pendingRuntimeRequest.kind !== "user_input",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    modelSelection: thread.modelSelection,
    latestRunId: thread.latestRunId,
    activeRunId: thread.activeRunId,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
  };
}

export function gatewayThreadProjection(projection: OrchestrationV2ThreadProjection) {
  const { thread } = projection;
  const latestRun = projection.runs.at(-1);
  const pending = projection.runtimeRequests.find((request) => request.status === "pending");
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: gatewayStatusFromThread({
      status: latestRun?.status ?? "idle",
      pendingRuntimeRequest: pending ?? null,
    }),
    hasPendingApprovals: pending !== undefined && pending.kind !== "user_input",
    hasPendingUserInput: pending?.kind === "user_input",
    modelSelection: thread.modelSelection,
    profileSnapshot: profileAssociation(thread.profileSnapshot),
    parentThreadId: thread.parentThreadId ?? null,
    settledAt: iso(thread.settledAt),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    runs: projection.runs.map((run) => ({
      id: run.id,
      status: run.status,
      providerInstanceId: run.providerInstanceId,
      requestedAt: iso(run.requestedAt),
      completedAt: iso(run.completedAt),
    })),
    messages: projection.messages.slice(-500).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text.slice(0, 120_000),
      runId: message.runId,
      streaming: message.streaming,
      attachments: message.attachments.slice(0, 100).map((attachment) => ({
        type: attachment.type,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
      createdAt: iso(message.createdAt),
      updatedAt: iso(message.updatedAt),
    })),
    runtimeRequests: projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => ({
        id: request.id,
        kind: request.kind,
        status: request.status,
        responseCapability: request.responseCapability.type,
      })),
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
  };
}

/** Bounded shell updates preserve the environment's native sequence and never fetch a transcript. */
export function gatewayEventFromV2(
  environmentId: EnvironmentId,
  item: OrchestrationV2ShellStreamItem,
): GatewayRuntimeEvent | undefined {
  if (item.kind !== "thread.updated") return undefined;
  return {
    eventId: `${environmentId}:${item.sequence}`,
    sequence: item.sequence,
    occurredAt: DateTime.formatIso(item.thread.updatedAt),
    environmentId,
    type: "thread.updated",
    threadId: item.thread.id,
    data: {
      threadId: item.thread.id,
      projectId: item.thread.projectId,
      title: item.thread.title,
      status: gatewayStatusFromThread(item.thread),
      latestRunId: item.thread.latestRunId,
      profileId: item.thread.profileSnapshot?.profileId ?? null,
    },
  };
}

const decodeProfile = Schema.decodeUnknownSync(McpGatewayProfile);
const decodeProfiles = Schema.decodeUnknownEffect(Schema.Array(McpGatewayProfile));

export function createGatewayRuntimeEventSourceFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto | ShellSnapshotLoader>,
): GatewayRuntimeEventSource {
  return {
    subscribe: (listener, subscription) => {
      const allowed = new Set(subscription.environmentIds);
      const stream = Stream.unwrap(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          // changes already includes the current entries; do not start a second replay.
          return SubscriptionRef.changes(registry.entries).pipe(
            Stream.switchMap((entries) =>
              Stream.mergeAll(
                [...entries.values()]
                  .filter((entry) => allowed.has(entry.target.environmentId))
                  .map((entry) => {
                    const environmentId = entry.target.environmentId;
                    return registry
                      .runStream(
                        environmentId,
                        subscribe(
                          ORCHESTRATION_V2_WS_METHODS.subscribeShell,
                          {
                            afterSequence:
                              subscription.afterSequenceByEnvironment[environmentId] ?? 0,
                          },
                          { streamBufferSize: 500 },
                        ),
                      )
                      .pipe(
                        Stream.map((item) => gatewayEventFromV2(environmentId, item)),
                        Stream.filter((event) => event !== undefined),
                        Stream.catchCause(() => Stream.empty),
                      );
                  }),
                { concurrency: "unbounded" },
              ),
            ),
          );
        }),
      );
      const fiber = Effect.runForkWith(context)(
        Stream.runForEach(stream, (event) => Effect.sync(() => listener(event))),
      );
      return () => fiber.interruptUnsafe();
    },
  };
}

export function createGatewayRuntimePort(
  runtime: GatewayEffectRuntime,
  openThread?: (environmentId: string, threadId: string) => Promise<void>,
  openAgents?: () => Promise<void>,
): GatewayRuntimePort {
  const run = <A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>) =>
    runtime.runPromise(effect);

  // Serialize shared library read/modify/write operations issued by this host.
  let profileQueue: Promise<unknown> = Promise.resolve();
  const mutateLibrary = (
    rawEnvironmentId: string,
    mutate: (settings: ServerSettings) => ServerSettingsPatch,
    requiresResources = false,
  ) => {
    const operation = profileQueue.then(() =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(rawEnvironmentId);
          if (requiresResources) {
            yield* registry.run(
              environmentId,
              Effect.gen(function* () {
                const supervisor = yield* EnvironmentSupervisor;
                const session = yield* SubscriptionRef.get(supervisor.session);
                if (
                  Option.isNone(session) ||
                  !(yield* session.value.initialConfig).environment.capabilities.agentSkillResources
                ) {
                  return yield* Effect.fail(
                    new EnvironmentRpcUnavailableError({
                      environmentId,
                      message: "Update T3 on this machine to import skill resources.",
                    }),
                  );
                }
              }),
            );
          }
          yield* registry.run(environmentId, syncAgentLibraryBeforeUse());
          const settings = yield* registry.run(
            environmentId,
            request(WS_METHODS.serverGetSettings, {}),
          );
          return yield* registry.run(
            environmentId,
            request(WS_METHODS.serverUpdateSettings, {
              patch: mutate(settings),
            }),
          );
        }),
      ),
    );
    profileQueue = operation.catch(() => undefined);
    return operation;
  };
  const mutateProfiles = (
    environmentId: string,
    mutate: (profiles: ReadonlyArray<McpGatewayProfile>) => ReadonlyArray<McpGatewayProfile>,
  ) =>
    mutateLibrary(environmentId, (settings) => ({
      mcpGatewayProfiles: mutate(settings.mcpGatewayProfiles),
    }));
  const decodeSkill = Schema.decodeUnknownSync(AgentSkill);
  const port: GatewayRuntimePort = {
    listSkills: async (environmentId) => {
      await port.syncAgentLibrary!(environmentId);
      return run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const settings = yield* registry.run(
            EnvironmentId.make(environmentId),
            request(WS_METHODS.serverGetSettings, {}),
          );
          return settings.agentSkills;
        }),
      );
    },
    createSkill: async (environmentId, input) => {
      const skillId = await run(
        Effect.gen(function* () {
          return yield* (yield* Crypto.Crypto).randomUUIDv4;
        }),
      );
      const now = await run(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      const skill = decodeSkill({ ...input, skillId, revision: 1, createdAt: now, updatedAt: now });
      const settings = await mutateLibrary(
        environmentId,
        (current) => ({
          agentSkills: [...current.agentSkills, skill],
        }),
        !!input.resources?.length,
      );
      return settings.agentSkills.find((item) => item.skillId === skillId)!;
    },
    updateSkill: async (environmentId, skillId, patch) => {
      const settings = await mutateLibrary(
        environmentId,
        (current) => {
          if (!current.agentSkills.some((skill) => skill.skillId === skillId))
            throw new Error(`Skill ${skillId} was not found.`);
          return {
            agentSkills: current.agentSkills.map((skill) =>
              skill.skillId === skillId ? decodeSkill({ ...skill, ...patch }) : skill,
            ),
          };
        },
        patch.resources !== undefined,
      );
      return settings.agentSkills.find((skill) => skill.skillId === skillId)!;
    },
    deleteSkill: async (environmentId, skillId) => {
      await mutateLibrary(environmentId, (current) => ({
        agentSkills: current.agentSkills.filter((skill) => skill.skillId !== skillId),
      }));
      return { skillId, status: "succeeded" };
    },
    syncAgentLibrary: (environmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(EnvironmentId.make(environmentId), syncAgentLibraryBeforeUse());
        }),
      ),
    unsettleThread: (environmentId, threadId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const crypto = yield* Crypto.Crypto;
          yield* registry.run(
            EnvironmentId.make(environmentId),
            unsettleThread({
              threadId: ThreadId.make(threadId),
              reason: "user",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
            }),
          );
          return { status: "succeeded" as const };
        }),
      ),
    settleThread: (environmentId, threadId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const crypto = yield* Crypto.Crypto;
          yield* registry.run(
            EnvironmentId.make(environmentId),
            settleThread({
              threadId: ThreadId.make(threadId),
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
            }),
          );
          return { status: "succeeded" as const };
        }),
      ),
    handoffThread: async (input) => {
      await port.syncAgentLibrary!(input.environmentId);
      const source = await run(shellSnapshot(EnvironmentId.make(input.sourceEnvironmentId)));
      const thread = source.threads.find((t) => t.id === input.sourceThreadId);
      const project = source.projects.find((p) => p.id === thread?.projectId);
      if (!thread || !project) throw new Error("Source thread or project is unavailable.");
      const target = await run(shellSnapshot(EnvironmentId.make(input.environmentId)));
      const targetProject = target.projects.find((p) => p.id === input.projectId);
      if (!targetProject) throw new Error("Destination project is unavailable.");
      return performAgentHandoff(port, input, {
        readSource: (path) =>
          run(
            Effect.gen(function* () {
              const registry = yield* EnvironmentRegistry;
              return yield* registry.run(
                EnvironmentId.make(input.sourceEnvironmentId),
                request(WS_METHODS.projectsReadFile, {
                  cwd: thread.worktreePath ?? project.workspaceRoot,
                  relativePath: path,
                }),
              );
            }),
          ),
        writeBrief: (path, contents) =>
          run(
            Effect.gen(function* () {
              const registry = yield* EnvironmentRegistry;
              yield* registry.run(
                EnvironmentId.make(input.environmentId),
                request(WS_METHODS.projectsWriteFile, {
                  cwd: targetProject.workspaceRoot,
                  relativePath: path,
                  contents,
                }),
              );
            }),
          ),
      });
    },
    openAgents: async () => {
      if (!openAgents) throw new Error("Desktop agents navigation is unavailable in this runtime.");
      await openAgents();
      return { status: "succeeded" };
    },
    createProfile: async (environmentId, input) => {
      const profileId = await run(
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          return yield* crypto.randomUUIDv4;
        }),
      );
      const now = await run(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      const profile = decodeProfile({
        ...input,
        profileId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const settings = await mutateProfiles(environmentId, (profiles) => [...profiles, profile]);
      return settings.mcpGatewayProfiles.find((item) => item.profileId === profileId)!;
    },
    updateProfile: async (environmentId, profileId, patch) => {
      const settings = await mutateProfiles(environmentId, (profiles) => {
        if (!profiles.some((profile) => profile.profileId === profileId))
          throw new Error(`Agent ${profileId} was not found.`);
        return profiles.map((profile) =>
          profile.profileId === profileId
            ? decodeProfile({
                ...profile,
                ...patch,
                ...(patch.providerLabel !== undefined || patch.modelLabel !== undefined
                  ? { modelSelection: undefined }
                  : {}),
              })
            : profile,
        );
      });
      return settings.mcpGatewayProfiles.find((profile) => profile.profileId === profileId)!;
    },
    deleteProfile: async (environmentId, profileId) => {
      const settings = await mutateProfiles(environmentId, (profiles) =>
        profiles.filter((profile) => profile.profileId !== profileId),
      );
      return {
        profileId,
        status: "succeeded",
        deletedAt: settings.mcpGatewayProfileDeletedAt[profileId],
      };
    },
    replicateProfiles: async (environmentId, profiles, deletedAt) => {
      await run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(environmentId),
            request(WS_METHODS.serverUpdateSettings, {
              patch: {
                mcpGatewayProfiles: yield* decodeProfiles(profiles),
                ...(deletedAt ? { mcpGatewayProfileDeletedAt: deletedAt } : {}),
              },
              replicateProfiles: true,
            }),
          );
        }),
      );
    },
    openThread: async (environmentId, threadId) => {
      if (!openThread) throw new Error("Desktop chat navigation is unavailable in this runtime.");
      const snapshot = await run(
        threadSnapshot(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
      );
      if (snapshot.thread.id !== threadId || snapshot.thread.deletedAt !== null) {
        throw new Error(`Thread ${threadId} was not found.`);
      }
      await openThread(environmentId, threadId);
      return { environmentId, threadId, status: "succeeded" };
    },
    listDevices: (environmentId) => run(listGatewayDevices(EnvironmentId.make(environmentId))),
    scheduledTask: (environmentId, scheduled) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            registry.run(EnvironmentId.make(environmentId), effect);
          const profileRouting = Effect.fn("gateway.scheduledTask.profileRouting")(function* (
            profileId: string,
          ) {
            const [settings, config] = yield* Effect.all([
              call(request(WS_METHODS.serverGetSettings, {})),
              call(request(WS_METHODS.serverGetConfig, {})),
            ]);
            const routing = resolveScheduledTaskProfileRouting(
              settings.mcpGatewayProfiles,
              profileId,
              config.providers,
            );
            return typeof routing === "string"
              ? yield* new ScheduledTaskError({ message: routing })
              : routing;
          });
          switch (scheduled.action) {
            case "list":
              return yield* call(request(WS_METHODS.scheduledTasksList, {}));
            case "create": {
              const { input } = scheduled;
              const routing = yield* profileRouting(input.profileId);
              const { task } = yield* call(
                request(WS_METHODS.scheduledTasksUpsert, {
                  title: input.title ?? defaultScheduledTaskTitle(input.prompt),
                  prompt: input.prompt,
                  enabled: input.enabled ?? true,
                  schedule: input.schedule,
                  projectId: ProjectId.make(input.projectId),
                  workspaceStrategy: { type: "root" },
                  ...routing,
                  createdBy: "agent",
                  creationSource: "mcp",
                }),
              );
              return task;
            }
            case "update": {
              const { patch } = scheduled;
              const { tasks } = yield* call(request(WS_METHODS.scheduledTasksList, {}));
              const existing = tasks.find((task) => task.id === scheduled.taskId);
              if (existing === undefined) {
                return yield* new ScheduledTaskError({
                  message: `Scheduled task ${scheduled.taskId} was not found.`,
                });
              }
              const routing =
                patch.profileId !== undefined && patch.profileId !== existing.profileId
                  ? yield* profileRouting(patch.profileId)
                  : {};
              const { task } = yield* call(
                request(WS_METHODS.scheduledTasksUpsert, {
                  id: existing.id,
                  requireExisting: true,
                  title: patch.title ?? existing.title,
                  prompt: patch.prompt ?? existing.prompt,
                  enabled: patch.enabled ?? existing.enabled,
                  schedule: patch.schedule ?? existing.schedule,
                  projectId:
                    patch.projectId === undefined
                      ? existing.projectId
                      : ProjectId.make(patch.projectId),
                  threadId: existing.threadId,
                  workspaceStrategy: existing.workspaceStrategy,
                  modelSelection: existing.modelSelection,
                  runtimeMode: existing.runtimeMode,
                  interactionMode: existing.interactionMode,
                  creationSource: existing.creationSource,
                  ...routing,
                }),
              );
              return task;
            }
            case "delete":
              yield* call(
                request(WS_METHODS.scheduledTasksDelete, {
                  id: ScheduledTaskId.make(scheduled.taskId),
                }),
              );
              return { deleted: scheduled.taskId };
            case "run": {
              const { task } = yield* call(
                request(WS_METHODS.scheduledTasksRunNow, {
                  id: ScheduledTaskId.make(scheduled.taskId),
                }),
              );
              return task;
            }
          }
        }),
      ),
    focusDevice: async (rawEnvironmentId, device, target) => {
      const environmentId = EnvironmentId.make(rawEnvironmentId);
      const resolved = resolveGatewayDevice(await run(listGatewayDevices(environmentId)), device);
      if (target.type !== "agents") {
        const snapshot = await run(threadSnapshot(environmentId, ThreadId.make(target.threadId)));
        if (snapshot.thread.id !== target.threadId || snapshot.thread.deletedAt !== null) {
          throw new Error(`Thread ${target.threadId} was not found.`);
        }
      }
      const result = await run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return yield* registry.run(
            environmentId,
            request(WS_METHODS.clientsFocus, {
              clientId: resolved.deviceId,
              target:
                target.type === "agents"
                  ? { _tag: "agents" }
                  : target.type === "thread"
                    ? { _tag: "thread", threadId: ThreadId.make(target.threadId) }
                    : {
                        _tag: "file",
                        threadId: ThreadId.make(target.threadId),
                        path: target.path,
                        ...(target.line === undefined ? {} : { line: target.line }),
                      },
            }),
          );
        }),
      );
      return { deviceId: result.clientId, label: result.label, status: "delivered" };
    },
    listEnvironments: () =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const entries = yield* SubscriptionRef.get(registry.entries);
          return yield* Effect.forEach([...entries.values()], (entry) =>
            registry.state(entry.target.environmentId).pipe(
              Effect.map((state) => ({
                environmentId: entry.target.environmentId,
                label: entry.target.label,
                targetKind: targetKind(entry.target._tag),
                connectionState: state.phase,
              })),
            ),
          );
        }),
      ),
    getEnvironmentStatus: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(rawEnvironmentId);
          const state = yield* registry.state(environmentId);
          return { environmentId, ...state } as Record<string, unknown>;
        }),
      ),
    listProfiles: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const settings = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.serverGetSettings, {}),
          );
          return settings.mcpGatewayProfiles.map((profile) => ({
            ...profile,
            modelSelection: profile.modelSelection as GatewayProfileModelSelection | undefined,
          }));
        }),
      ),
    resolveProfileModelSelection: (rawEnvironmentId, profile) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const config = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.serverGetConfig, {}),
          );
          return resolveGatewayProfileModelSelection(profile, config.providers);
        }),
      ),
    listProjects: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.projects.map(gatewayProjectProjection),
        snapshotAt: DateTime.formatIso(DateTime.nowUnsafe()),
      })),
    listThreads: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.threads.map(gatewayThreadShellProjection),
        snapshotAt: DateTime.formatIso(DateTime.nowUnsafe()),
      })),
    getThread: (rawEnvironmentId, rawThreadId) =>
      run(threadSnapshot(EnvironmentId.make(rawEnvironmentId), ThreadId.make(rawThreadId))).then(
        (snapshot) => gatewayThreadProjection(snapshot),
      ),
    hasThreadMessage: (rawEnvironmentId, rawThreadId, rawMessageId) =>
      run(threadSnapshot(EnvironmentId.make(rawEnvironmentId), ThreadId.make(rawThreadId))).then(
        (snapshot) => snapshot.messages.some((message) => message.id === rawMessageId),
      ),
    createAssetUrl: (rawEnvironmentId, resource) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const typedResource =
            resource._tag === "attachment"
              ? resource
              : { ...resource, threadId: ThreadId.make(resource.threadId) };
          const asset = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.assetsCreateUrl, { resource: typedResource }),
          );
          return { relativeUrl: asset.relativeUrl, expiresAt: asset.expiresAt };
        }),
      ),
    getPullRequest: (rawEnvironmentId, ref) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return (yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.pullRequestsDetail, {
              ...ref,
              projectId: ProjectId.make(ref.projectId),
            }),
          )) as Record<string, unknown>;
        }),
      ),
    getPullRequestActivity: (rawEnvironmentId, ref) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return (yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.pullRequestsActivity, {
              ...ref,
              projectId: ProjectId.make(ref.projectId),
            }),
          )) as Record<string, unknown>;
        }),
      ),
    getCommandReceipts: (rawEnvironmentId, commandIds) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const result = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(ORCHESTRATION_V2_WS_METHODS.getCommandReceipts, {
              commandIds: commandIds.map((commandId) => CommandId.make(commandId)),
            }),
          );
          return result.receipts;
        }),
      ),
    createThread: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(input.environmentId);
          if (input.profileSelection)
            yield* registry.run(
              environmentId,
              syncAgentLibraryBeforeUse(input.profileSelection.profileId),
            );
          const config = yield* registry.run(
            environmentId,
            request(WS_METHODS.serverGetConfig, {}),
          );
          const settings = yield* registry.run(
            environmentId,
            request(WS_METHODS.serverGetSettings, {}),
          );
          const profile = settings.mcpGatewayProfiles.find(
            (profile) => profile.profileId === input.profileSelection?.profileId,
          );
          const selection =
            input.modelSelection ??
            (profile
              ? resolveGatewayProfileModelSelection(profile, config.providers)
              : settings.defaultModelSelection);
          if (!selection)
            throw new Error("Select an enabled provider and model on the target machine.");

          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            request(ORCHESTRATION_V2_WS_METHODS.launchThread, {
              ...(input.parentThreadId === undefined
                ? {}
                : { parentThreadId: ThreadId.make(input.parentThreadId) }),
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              projectId: ProjectId.make(input.projectId),
              title: input.title,
              modelSelection: {
                model: selection.model,
                instanceId: ProviderInstanceId.make(selection.instanceId),
                ...(selection.options === undefined ? {} : { options: selection.options }),
              },
              runtimeMode:
                input.runtimeMode ??
                (profile?.runtimeMode === "read-only"
                  ? settings.defaultRuntimeMode
                  : profile?.runtimeMode) ??
                settings.defaultRuntimeMode,
              interactionMode: input.interactionMode ?? profile?.interactionMode ?? "default",
              ...(input.profileSelection === undefined
                ? {}
                : {
                    profileSelection: {
                      ...input.profileSelection,
                      revision: profile?.revision ?? input.profileSelection.revision,
                    },
                  }),
              workspaceStrategy:
                input.workspaceMode === "worktree"
                  ? { type: "worktree", baseRef: input.baseBranch?.trim() || "HEAD" }
                  : { type: "root", ...(input.baseBranch ? { branch: input.baseBranch } : {}) },
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    sendMessage: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const shell = yield* shellSnapshot(environmentId);
          const thread = shell.threads.find((candidate) => candidate.id === threadId);
          if (thread === undefined) throw new Error(`Thread ${input.threadId} was not found.`);
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            environmentId,
            startThreadTurn({
              commandId: CommandId.make(input.requestId),
              threadId,
              message: {
                messageId: MessageId.make(input.messageId),
                role: "user",
                text: input.text,
                attachments: [],
              },
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
            messageId: input.messageId,
          };
        }),
      ),
    controlThread: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const thread = (yield* threadSnapshot(environmentId, threadId)).thread;
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            environmentId,
            input.action === "pause" || input.action === "cancel"
              ? interruptThreadTurn({ threadId, commandId: CommandId.make(input.requestId) })
              : input.action === "stop"
                ? stopThreadSession({ threadId, commandId: CommandId.make(input.requestId) })
                : startThreadTurn({
                    threadId,
                    commandId: CommandId.make(input.requestId),
                    message: {
                      messageId: MessageId.make(input.messageId),
                      role: "user",
                      text: "Continue the task.",
                      attachments: [],
                    },
                    runtimeMode: thread.runtimeMode,
                    interactionMode: thread.interactionMode,
                    dispatchMode: input.action === "restart" ? "restart" : "auto",
                  }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    respondToApproval: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            respondToThreadApproval({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              requestId: RuntimeRequestId.make(input.approvalRequestId),
              decision: input.decision,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    executeOperation: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(input.environmentId);
          const payload = input.payload;
          const projectId =
            typeof payload.projectId === "string" ? ProjectId.make(payload.projectId) : undefined;
          const project =
            projectId === undefined
              ? undefined
              : (yield* shellSnapshot(environmentId)).projects.find(
                  (candidate) => candidate.id === projectId,
                );
          const cwd = project?.workspaceRoot;
          if (input.operation === "approval.modify") {
            throw new Error(
              "V2 requires responding to individual runtime requests; atomic approval plans are not supported.",
            );
          }

          if (input.operation === "git.status") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            return (yield* registry.run(
              environmentId,
              subscribe(WS_METHODS.subscribeVcsStatus, { cwd }).pipe(
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              ),
            )) as unknown as Record<string, unknown>;
          }
          if (input.operation === "git.diff") {
            const rawThreadId = String(payload.threadId ?? "");
            const detail = yield* threadSnapshot(environmentId, ThreadId.make(rawThreadId));
            return (yield* registry.run(
              environmentId,
              request(ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff, {
                threadId: ThreadId.make(rawThreadId),
                toTurnCount: Math.max(
                  0,
                  ...detail.checkpoints
                    .filter((checkpoint) => checkpoint.status === "ready")
                    .map((checkpoint) => checkpoint.appRunOrdinal ?? 0),
                ),
              }),
            )) as unknown as Record<string, unknown>;
          }
          const prRef = {
            projectId: ProjectId.make(String(payload.projectId ?? "")),
            repository: String(payload.repository ?? ""),
            number: Number(payload.number),
          };
          if (input.operation === "pr.apply_review_fixes") {
            const activity = yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsActivity, prRef),
            );
            const requestedIds = new Set(
              Array.isArray(payload.commentIds)
                ? payload.commentIds.filter((id): id is string => typeof id === "string")
                : [],
            );
            const selectedThreads = activity.reviewThreads.filter((thread) =>
              requestedIds.has(thread.id),
            );
            if (selectedThreads.length !== requestedIds.size) {
              throw new Error("One or more review comment IDs are no longer available.");
            }
            const threadId = ThreadId.make(String(payload.threadId ?? ""));
            const shell = yield* shellSnapshot(environmentId);
            const thread = shell.threads.find((candidate) => candidate.id === threadId);
            if (thread === undefined) throw new Error(`Thread ${threadId} was not found.`);
            const requestId = input.requestId ?? `gateway-pr-fixes-${String(payload.number)}`;
            const instructions = selectedThreads
              .map(
                (reviewThread) =>
                  `${reviewThread.path}:${String(reviewThread.line ?? "file")}\n${reviewThread.comments
                    .map((comment) => comment.body)
                    .join("\n")}`,
              )
              .join("\n\n");
            yield* registry.run(
              environmentId,
              startThreadTurn({
                commandId: CommandId.make(requestId),
                threadId,
                message: {
                  messageId: MessageId.make(`${requestId}-message`),
                  role: "user",
                  text: `Apply only these approved pull request review fixes. Do not resolve review threads; they remain unresolved until the pull request is refreshed.\n\n${instructions}`,
                  attachments: [],
                },
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              }),
            );
            return { queued: true, threadId, reviewThreadIds: [...requestedIds] };
          }
          if (input.operation === "pr.update") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsUpdate, {
                ...prRef,
                ...(typeof payload.title === "string" ? { title: payload.title } : {}),
                ...(typeof payload.body === "string" ? { body: payload.body } : {}),
              }),
            );
            return { updated: true };
          }
          if (input.operation === "pr.reply") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsReplyToThread, {
                ...prRef,
                threadId: String(payload.commentId ?? ""),
                body: String(payload.body ?? ""),
              }),
            );
            return { replied: true };
          }
          if (input.operation === "pr.publish") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsRunAction, { ...prRef, action: "ready" }),
            );
            return { published: true };
          }
          if (input.operation === "git.apply_patch") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            yield* registry.run(
              environmentId,
              request(WS_METHODS.vcsApplyPatch, {
                cwd,
                patch: String(payload.patch),
              }),
            );
            return { applied: true };
          }
          if (input.operation === "git.create_branch") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            return (yield* registry.run(
              environmentId,
              request(WS_METHODS.vcsCreateRef, {
                cwd,
                refName: String(payload.branch ?? ""),
                switchRef: true,
              }),
            )) as unknown as Record<string, unknown>;
          }
          if (input.operation === "git.commit" || input.operation === "git.create_pr") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            const action = input.operation === "git.commit" ? "commit" : "create_pr";
            if (input.operation === "git.create_pr") {
              const refs = yield* registry.run(
                environmentId,
                request(WS_METHODS.vcsListRefs, {
                  cwd,
                  refKind: "all",
                  includeMatchingRemoteRefs: true,
                  refresh: true,
                  limit: 500,
                }),
              );
              const head = refs.refs.find((ref) => ref.current)?.name;
              const defaultRefs = refs.refs
                .filter((ref) => ref.isDefault)
                .map((ref) => ref.name.split("/").at(-1));
              if (
                head !== payload.headBranch ||
                !defaultRefs.includes(String(payload.baseBranch))
              ) {
                throw new Error(
                  "Pull request head/base must match the selected project's current and default refs.",
                );
              }
            }
            const progress = yield* registry.run(
              environmentId,
              runStream(WS_METHODS.gitRunStackedAction, {
                actionId: input.requestId ?? `gateway-${input.operation}`,
                cwd,
                action,
                ...(input.operation === "git.create_pr" && typeof payload.draft === "boolean"
                  ? { draft: payload.draft }
                  : {}),
                ...(typeof payload.message === "string" ? { commitMessage: payload.message } : {}),
                ...(Array.isArray(payload.paths)
                  ? {
                      filePaths: payload.paths.filter(
                        (path): path is string => typeof path === "string",
                      ),
                    }
                  : {}),
              }).pipe(Stream.runLast, Effect.map(Option.getOrThrow)),
            );
            const result =
              typeof progress === "object" &&
              progress !== null &&
              "kind" in progress &&
              progress.kind === "action_finished"
                ? progress.result
                : undefined;
            if (
              input.operation === "git.create_pr" &&
              result?.pr.number !== undefined &&
              typeof payload.owner === "string" &&
              typeof payload.repository === "string" &&
              typeof payload.title === "string"
            ) {
              yield* registry.run(
                environmentId,
                request(WS_METHODS.pullRequestsUpdate, {
                  projectId: ProjectId.make(String(payload.projectId)),
                  repository: payload.repository,
                  number: result.pr.number,
                  title: payload.title,
                  ...(typeof payload.body === "string" ? { body: payload.body } : {}),
                }),
              );
            }
            return (result ?? progress) as unknown as Record<string, unknown>;
          }
          throw new Error(`Gateway operation ${input.operation} is not supported by this runtime.`);
        }),
      ),
  };
  return port;
}
