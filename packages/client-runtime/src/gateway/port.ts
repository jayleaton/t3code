export const GATEWAY_SCOPE_VALUES = [
  "read",
  "create",
  "send",
  "control",
  "lifecycle",
  "approval",
  "artifact",
  "review",
  "admin",
  "delivery",
] as const;
export type GatewayScope = (typeof GATEWAY_SCOPE_VALUES)[number];

export function hasGatewayScopes(
  grants: Readonly<Record<string, ReadonlyArray<GatewayScope>>>,
  environmentId: string,
  required: ReadonlyArray<GatewayScope>,
): boolean {
  const scopes = grants[environmentId];
  return scopes !== undefined && required.every((scope) => scopes.includes(scope));
}
export type GatewayThreadControlAction =
  | "cancel"
  | "stop"
  | "pause"
  | "resume"
  | "retry"
  | "restart";
export type GatewayApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface GatewayProfile {
  readonly profileId?: string | undefined;
  readonly name: string;
  /**
   * Readable selection text persisted with the profile. The label pair is
   * the agent-facing representation; `modelSelection` below is a transient
   * routing snapshot resolved against the live catalog and is not profile
   * identity.
   */
  readonly providerLabel?: string | undefined;
  readonly modelLabel?: string | undefined;
  readonly modelSelection?: GatewayProfileModelSelection | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly runtimeMode:
    | "approval-required"
    | "auto-accept-edits"
    | "auto"
    | "full-access"
    | "read-only";
  readonly interactionMode: "default" | "plan";
  readonly environmentIds?: ReadonlyArray<string> | undefined;
  readonly revision?: number | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface GatewayProfileModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
}

export interface GatewayEnvironmentSummary {
  readonly environmentId: string;
  readonly label: string;
  readonly targetKind: string;
  readonly connectionState: string;
  readonly serverVersion?: string;
  readonly grantedScopes?: ReadonlyArray<string>;
}

export interface GatewayPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor?: string;
  readonly snapshotAt: string;
}

export interface GatewayMutationResult {
  readonly requestId: string;
  readonly commandId?: string;
  readonly status: "accepted" | "queued" | "running" | "succeeded" | "failed" | "denied";
  readonly threadId: string;
  readonly messageId?: string;
}

export interface GatewayRuntimeEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly environmentId: string;
  readonly type: string;
  readonly correlationId?: string;
  readonly threadId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface GatewayRuntimeEventSubscription {
  readonly environmentIds: ReadonlyArray<string>;
  readonly afterSequenceByEnvironment: Readonly<Record<string, number>>;
}

export interface GatewayRuntimeEventSource {
  subscribe(
    listener: (event: GatewayRuntimeEvent) => void,
    subscription: GatewayRuntimeEventSubscription,
  ): () => void;
}

export interface GatewayRuntimePort {
  listEnvironments(): Promise<ReadonlyArray<GatewayEnvironmentSummary>>;
  getEnvironmentStatus(environmentId: string): Promise<Record<string, unknown>>;
  listProfiles?(environmentId: string): Promise<ReadonlyArray<GatewayProfile>>;
  /** Resolve readable profile labels against the environment's live provider catalog. */
  resolveProfileModelSelection?(
    environmentId: string,
    profile: GatewayProfile,
  ): Promise<GatewayProfileModelSelection | undefined>;
  listProjects(environmentId: string): Promise<GatewayPage<Record<string, unknown>>>;
  listThreads(environmentId: string): Promise<GatewayPage<Record<string, unknown>>>;
  getThread(environmentId: string, threadId: string): Promise<Record<string, unknown>>;
  createAssetUrl(
    environmentId: string,
    resource:
      | { readonly _tag: "attachment"; readonly attachmentId: string }
      | { readonly _tag: "workspace-file"; readonly threadId: string; readonly path: string },
  ): Promise<{
    readonly relativeUrl: string;
    readonly expiresAt: number;
  }>;
  getPullRequest(
    environmentId: string,
    ref: { readonly projectId: string; readonly repository: string; readonly number: number },
  ): Promise<Record<string, unknown>>;
  getPullRequestActivity(
    environmentId: string,
    ref: { readonly projectId: string; readonly repository: string; readonly number: number },
  ): Promise<Record<string, unknown>>;
  createThread(input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly title: string;
    readonly modelSelection?: {
      readonly instanceId: string;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
    };
    readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode?: "default" | "plan";
    readonly requestId: string;
    readonly profileSelection?: {
      readonly profileId: string;
      readonly revision: number;
      readonly overrideFields: ReadonlyArray<
        "modelSelection" | "runtimeMode" | "interactionMode" | "reasoningEffort"
      >;
    };
  }): Promise<GatewayMutationResult>;
  sendMessage(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly text: string;
    readonly messageId: string;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  controlThread(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly action: GatewayThreadControlAction;
    readonly requestId: string;
    readonly messageId: string;
  }): Promise<GatewayMutationResult>;
  respondToApprovals?(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly responses: ReadonlyArray<{
      readonly approvalRequestId: string;
      readonly decision: GatewayApprovalDecision;
    }>;
    readonly expectedRevision: number;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  respondToApproval(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly approvalRequestId: string;
    readonly decision: GatewayApprovalDecision;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  /** Extended v3 operations that map directly to authoritative server RPCs.
   * Kept behind one transport method so older bridge clients fail closed. */
  executeOperation?(input: {
    readonly operation: string;
    readonly environmentId: string;
    readonly requestId?: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<Record<string, unknown>>;
}
