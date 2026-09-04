export type GatewayScope = "read" | "create" | "send" | "control" | "delivery";
export type GatewayThreadControlAction =
  | "cancel"
  | "stop"
  | "pause"
  | "resume"
  | "retry"
  | "restart";
export type GatewayApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface GatewayProfile {
  readonly profileId?: string;
  readonly name: string;
  readonly modelSelection: { readonly instanceId: string; readonly model: string };
  readonly reasoningEffort?: string;
  readonly runtimeMode:
    | "approval-required"
    | "auto-accept-edits"
    | "auto"
    | "full-access"
    | "read-only";
  readonly interactionMode: "default" | "plan";
  readonly environmentIds?: ReadonlyArray<string>;
  readonly revision?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
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
    readonly sourcePath?: string | undefined;
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
    readonly modelSelection: { readonly instanceId: string; readonly model: string };
    readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode: "default" | "plan";
    readonly requestId: string;
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
  respondToApproval(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly approvalRequestId: string;
    readonly decision: GatewayApprovalDecision;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
}
