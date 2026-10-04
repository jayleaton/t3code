import { useAtom, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  MCP_GATEWAY_RUNTIME_MODE_LABELS,
  type EnvironmentId,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import {
  agentThreadStatus,
  agentThreadStatusLabel,
  excludePinnedAgentThreads,
  nestAgentRuns,
  selectAgentSidebarThreads,
  selectAgentWorkspaceThreads,
  selectPinnedAgentThreads,
} from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveGatewayProfileModelSelection } from "@t3tools/client-runtime/gateway";
import { AgentAvatar } from "../../components/AgentAvatar";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { SegmentedControl } from "../../components/SegmentedControl";
import { cn } from "../../lib/cn";
import {
  agentAppearance,
  agentModelLabel,
  threadAgentAppearance,
  useAgentProfiles,
  type AgentAppearance,
} from "../../state/agents";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { useWorkspaceState } from "../../state/workspace";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { agentsBoardSelectionAtom } from "./agents-board-state";

const BOARD_TABS = [
  { value: "agents", label: "Agents" },
  { value: "threads", label: "Threads" },
] as const;

export function WorkspaceBoardTabs() {
  const [selection, setSelection] = useAtom(agentsBoardSelectionAtom);
  return (
    <View className="px-4 py-3">
      <SegmentedControl
        options={BOARD_TABS}
        selected={selection.tab}
        onSelect={(tab) => setSelection({ ...selection, tab })}
        role="tab"
      />
    </View>
  );
}

type AgentChatStatus = ReturnType<typeof agentThreadStatus>;

const STATUS_DOT_CLASS: Record<AgentChatStatus, string> = {
  attention: "bg-warning",
  error: "bg-danger",
  running: "bg-primary",
  monitoring: "bg-primary",
  queued: "bg-foreground-tertiary",
  idle: "bg-foreground-tertiary",
  done: "bg-foreground-tertiary",
};

interface AgentActivity {
  readonly active: number;
  readonly working: number;
  readonly attention: number;
}

type BoardRow =
  | { readonly thread: EnvironmentThreadShell; readonly depth: number }
  | {
      readonly kind: "settled" | "card-settled";
      readonly key: string;
      readonly count: number;
      readonly open: boolean;
    };

const NO_ACTIVITY: AgentActivity = { active: 0, working: 0, attention: 0 };

function agentActivityLabel(activity: AgentActivity): string {
  if (activity.active === 0) return "No open chats";
  return [
    `${activity.active} open`,
    ...(activity.working > 0 ? [`${activity.working} working`] : []),
    ...(activity.attention > 0 ? [`${activity.attention} need input`] : []),
  ].join(" · ");
}

export function AgentsBoard(props: {
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onStartAgentChat: (profileId: string, environmentId: EnvironmentId | null) => void;
  readonly onSelectPendingTask: (task: PendingNewTask) => void;
  readonly searchQuery: string;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: readonly { environmentId: EnvironmentId; projectId: string }[] | null;
  readonly topInset?: number;
}) {
  const threads = useThreadShells();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const { state: catalogState } = useWorkspaceState();
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useAtom(agentsBoardSelectionAtom);
  const [settledOpen, setSettledOpen] = useState(false);
  const { settleThread, unsettleThread, pinThread, unpinThread } = useThreadListActions();
  const pending = usePendingNewTasks();
  const { confirmDeletePendingTask } = usePendingTaskListActions();
  const profiles = useAgentProfiles();
  const profileId = profiles.some((profile) => profile.profileId === selection.profileId)
    ? selection.profileId
    : null;
  const selectAgent = (id: string | null) => setSelection({ ...selection, profileId: id });
  // Delegated tasks belong to their parent chat's lineage, never this roster.
  const scoped = useMemo(
    () =>
      selectAgentSidebarThreads(threads).filter(
        (thread) =>
          thread.archivedAt === null &&
          (props.environmentId === null || thread.environmentId === props.environmentId) &&
          (!props.projectRefs ||
            props.projectRefs.some(
              (ref) =>
                ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
            )),
      ),
    [threads, props.environmentId, props.projectRefs],
  );
  const activityByProfile = useMemo(() => {
    const activity = new Map<string, { active: number; working: number; attention: number }>();
    for (const thread of scoped) {
      const id = thread.profileSnapshot?.profileId;
      if (!id || thread.settledAt !== null) continue;
      const entry = activity.get(id) ?? { active: 0, working: 0, attention: 0 };
      const status = agentThreadStatus(thread);
      entry.active += 1;
      if (status === "running" || status === "queued" || status === "monitoring")
        entry.working += 1;
      if (status === "attention" || status === "error") entry.attention += 1;
      activity.set(id, entry);
    }
    return activity;
  }, [scoped]);
  const board = useMemo(() => {
    const pinned = selectPinnedAgentThreads(
      scoped.filter(
        (thread) =>
          thread.profileSnapshot?.profileId &&
          (profileId === null || thread.profileSnapshot.profileId === profileId),
      ),
    );
    const { active, settled } = selectAgentWorkspaceThreads(scoped, profileId, props.searchQuery);
    return nestAgentRuns({
      lists: { pinned, active: excludePinnedAgentThreads(active, pinned), settled },
      all: scoped,
    });
  }, [scoped, profileId, props.searchQuery]);
  // Settled parents sit behind one toggle row between the open and settled
  // chats; each card's settled child agents sit behind that card's own toggle,
  // so opening one never floods the list with every other card's history.
  const [expandedCards, setExpandedCards] = useState<ReadonlySet<string>>(new Set());
  const toggleCard = useCallback(
    (key: string) =>
      setExpandedCards((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const rows = useMemo((): BoardRow[] => {
    const append = (items: readonly EnvironmentThreadShell[]): BoardRow[] =>
      items.flatMap((thread) => {
        const key = `${thread.environmentId}:${thread.id}`;
        const children = board.childrenByKey.get(key);
        const settledChildren = children?.settled ?? [];
        const open = expandedCards.has(key);
        return [
          { thread, depth: 0 },
          ...(children?.live ?? []).map((child) => ({ ...child, depth: child.depth + 1 })),
          ...(settledChildren.length > 0
            ? [{ kind: "card-settled" as const, key, count: settledChildren.length, open }]
            : []),
          ...(open ? settledChildren.map((child) => ({ ...child, depth: child.depth + 1 })) : []),
        ];
      });
    const settledCount = board.lists.settled.length;
    // Rows carry their counts so the list re-renders them when the filter changes.
    return [
      ...append(board.lists.pinned),
      ...append(board.lists.active),
      ...(settledCount > 0
        ? [{ kind: "settled" as const, key: "settled", count: settledCount, open: settledOpen }]
        : []),
      ...(settledOpen ? append(board.lists.settled) : []),
    ];
  }, [board, settledOpen, expandedCards]);
  const jumpItems = useMemo(
    () =>
      rows.flatMap((row) =>
        "kind" in row ? [] : [{ type: "agent-thread" as const, thread: row.thread }],
      ),
    [rows],
  );
  useThreadJumpShortcuts(jumpItems, props.onSelectThread);
  const search = props.searchQuery.trim().toLocaleLowerCase();
  const scopedPending = pending.flatMap((task) => {
    const profileSelection =
      task.kind === "pending" ? task.creation.profileSelection : task.draft.profileSelection;
    return profileSelection &&
      (profileId === null || profileSelection.profileId === profileId) &&
      (props.environmentId === null || task.environmentId === props.environmentId) &&
      (!props.projectRefs ||
        props.projectRefs.some(
          (ref) => ref.environmentId === task.environmentId && ref.projectId === task.projectId,
        )) &&
      task.title.toLocaleLowerCase().includes(search)
      ? [
          {
            task,
            agent: threadAgentAppearance({ ...profileSelection, profileName: null }, profiles),
          },
        ]
      : [];
  });
  /** Why a chat with this agent cannot start here, or null when it can. */
  const unavailableReason = (profile: McpGatewayProfile): string | null => {
    if (profile.runtimeMode === "read-only") return "Read-only agent";
    const connected = environments.filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        (props.environmentId === null || environment.environmentId === props.environmentId),
    );
    if (connected.length === 0) return "Offline";
    const hosting = connected.filter(
      (environment) =>
        (!profile.environmentIds?.length ||
          profile.environmentIds.includes(environment.environmentId)) &&
        environment.serverConfig?.settings.mcpGatewayProfiles.some(
          (candidate) =>
            candidate.profileId === profile.profileId && candidate.revision === profile.revision,
        ),
    );
    if (hosting.length === 0) return "Not on this environment";
    return hosting.some(
      (environment) =>
        environment.serverConfig &&
        resolveGatewayProfileModelSelection(profile, environment.serverConfig.providers),
    )
      ? null
      : "Model unavailable";
  };
  const startChat = (id: string) => props.onStartAgentChat(id, props.environmentId);
  const selectedProfile = profiles.find((profile) => profile.profileId === profileId);
  const renderRow = useCallback(
    ({ item }: { item: (typeof rows)[number] }) => {
      if ("kind" in item) {
        return item.kind === "settled" ? (
          <SettledToggle
            label={item.count === 1 ? "settled chat" : "settled chats"}
            count={item.count}
            open={item.open}
            onToggle={() => setSettledOpen((open) => !open)}
          />
        ) : (
          <SettledToggle
            label={item.count === 1 ? "settled child agent" : "settled child agents"}
            count={item.count}
            open={item.open}
            nested
            onToggle={() => toggleCard(item.key)}
          />
        );
      }
      const environment = environments.find(
        (candidate) => candidate.environmentId === item.thread.environmentId,
      );
      const connected = environment?.connection.phase === "connected";
      const capabilities = configs.get(item.thread.environmentId)?.environment.capabilities;
      return (
        <AgentChatCard
          {...item}
          agent={threadAgentAppearance(item.thread.profileSnapshot, profiles)}
          connected={connected}
          environmentLabel={environments.length > 1 ? environment?.label : undefined}
          canSettle={connected && capabilities?.threadSettlement === true}
          canPin={connected && capabilities?.threadPinning === true}
          onSelectThread={props.onSelectThread}
          settleThread={settleThread}
          unsettleThread={unsettleThread}
          pinThread={pinThread}
          unpinThread={unpinThread}
        />
      );
    },
    [
      toggleCard,
      environments,
      configs,
      profiles,
      props.onSelectThread,
      settleThread,
      unsettleThread,
      pinThread,
      unpinThread,
    ],
  );

  const connecting =
    catalogState.isLoadingConnections ||
    (catalogState.hasConnectingEnvironment && !catalogState.hasLoadedShellSnapshot);
  const boardEmpty = connecting ? (
    <EmptyState
      variant="plain"
      title="Connecting"
      detail="Loading agents and chats from your environments."
    />
  ) : !catalogState.hasConnections ? (
    <EmptyState
      variant="plain"
      title="No environments connected"
      detail="Connect an environment to see its agents and chats."
    />
  ) : profiles.length === 0 ? (
    <EmptyState
      variant="plain"
      title="No agents yet"
      detail="Create agents in T3 Code on web or desktop. They show up here once saved."
    />
  ) : null;

  return (
    <View className="flex-1">
      <LegendList
        style={{ flex: 1 }}
        data={boardEmpty ? [] : rows}
        keyExtractor={(row) =>
          "kind" in row ? `${row.kind}:${row.key}` : `${row.thread.environmentId}:${row.thread.id}`
        }
        estimatedItemSize={76}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: props.topInset ?? 0,
          paddingBottom: Math.max(insets.bottom, 24) + 148,
        }}
        ListHeaderComponent={
          <View>
            <WorkspaceBoardTabs />
            {boardEmpty ?? (
              <>
                <AgentStrip
                  profiles={profiles}
                  selectedProfileId={profileId}
                  activityByProfile={activityByProfile}
                  onSelect={selectAgent}
                />
                {selectedProfile ? (
                  <AgentHero
                    agent={agentAppearance(selectedProfile, profiles)}
                    profile={selectedProfile}
                    activity={activityByProfile.get(selectedProfile.profileId) ?? NO_ACTIVITY}
                    unavailableReason={unavailableReason(selectedProfile)}
                    onStartChat={() => startChat(selectedProfile.profileId)}
                  />
                ) : null}
                <SectionLabel
                  title="Open chats"
                  count={
                    board.lists.pinned.length + board.lists.active.length + scopedPending.length
                  }
                />
                {scopedPending.map(({ task, agent }) => (
                  <PendingAgentTaskRow
                    key={task.key}
                    task={task}
                    agent={agent}
                    onOpen={props.onSelectPendingTask}
                    onDiscard={confirmDeletePendingTask}
                  />
                ))}
              </>
            )}
          </View>
        }
        ListEmptyComponent={
          boardEmpty || scopedPending.length > 0 ? null : (
            <Text className="mx-4 rounded-[18px] bg-card px-4 py-5 text-center text-sm text-foreground-muted">
              {search
                ? "No matching agent chats."
                : selectedProfile
                  ? `No open chats with ${selectedProfile.name}.`
                  : "No open agent chats. Start one from an agent below."}
            </Text>
          )
        }
        ListFooterComponent={
          boardEmpty ? null : (
            <View>
              {selectedProfile ? null : (
                <AgentDirectory
                  profiles={profiles}
                  activityByProfile={activityByProfile}
                  unavailableReason={unavailableReason}
                  onSelect={selectAgent}
                  onStartChat={startChat}
                />
              )}
            </View>
          )
        }
        renderItem={renderRow}
      />
      {settledOpen && !boardEmpty ? (
        // Hundreds of settled chats can follow the toggle, so closing them
        // never needs a scroll back to it.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide settled chats"
          onPress={() => setSettledOpen(false)}
          className="absolute flex-row items-center gap-1.5 self-center rounded-full border border-border-subtle bg-card px-4 py-2.5 shadow-sm active:opacity-70"
          style={{ bottom: Math.max(insets.bottom, 24) + 76 }}
        >
          <SymbolView
            name="chevron.up"
            size={12}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <Text className="text-sm font-t3-medium text-foreground">Hide settled chats</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SettledToggle(props: {
  readonly label: string;
  readonly count: number;
  readonly open: boolean;
  /** Under a card, indented to its child agents. */
  readonly nested?: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <View className={props.nested ? undefined : "pt-2"}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.open }}
        onPress={props.onToggle}
        className={cn(
          "flex-row items-center gap-1.5 self-start rounded-full px-2 py-2 active:opacity-60",
          props.nested ? "ms-12" : "mx-4",
        )}
      >
        <SymbolView
          name={props.open ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="text-sm font-t3-medium text-foreground-muted">
          {`${props.open ? "Hide" : "Show"} ${props.count} ${props.label}`}
        </Text>
      </Pressable>
    </View>
  );
}

function SectionLabel(props: { readonly title: string; readonly count?: number }) {
  return (
    <View className="flex-row items-baseline gap-2 px-5 pb-2 pt-5">
      <Text className="text-xs font-t3-bold uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      {props.count ? (
        <Text className="text-xs tabular-nums text-foreground-tertiary">{props.count}</Text>
      ) : null}
    </View>
  );
}

/** Filter chips: All, then every agent with a dot when it has work in flight. */
function AgentStrip(props: {
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly selectedProfileId: string | null;
  readonly activityByProfile: ReadonlyMap<string, AgentActivity>;
  readonly onSelect: (profileId: string | null) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All agents"
        accessibilityState={{ selected: props.selectedProfileId === null }}
        onPress={() => props.onSelect(null)}
        className={cn(
          "flex-row items-center gap-2 rounded-full border px-3.5 py-2",
          props.selectedProfileId === null
            ? "border-primary bg-secondary"
            : "border-border-subtle bg-card",
        )}
      >
        <SymbolView
          name="square.grid.2x2"
          size={14}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
        <Text className="text-sm font-t3-medium text-foreground">All</Text>
      </Pressable>
      {props.profiles.map((profile) => {
        const agent = agentAppearance(profile, props.profiles);
        const activity = props.activityByProfile.get(profile.profileId);
        const selected = props.selectedProfileId === profile.profileId;
        return (
          <Pressable
            key={profile.profileId}
            accessibilityRole="button"
            accessibilityLabel={`${profile.name}${activity ? `, ${agentActivityLabel(activity)}` : ""}`}
            accessibilityState={{ selected }}
            onPress={() => props.onSelect(profile.profileId)}
            className={cn(
              "flex-row items-center gap-2 rounded-full border py-1.5 pe-3.5 ps-1.5",
              selected ? "border-primary bg-secondary" : "border-border-subtle bg-card",
            )}
          >
            <AgentAvatar icon={agent.icon} color={agent.color} size={24} />
            <Text className="text-sm font-t3-medium text-foreground">{profile.name}</Text>
            {activity && (activity.working > 0 || activity.attention > 0) ? (
              <View
                className={cn(
                  "h-2 w-2 rounded-full",
                  activity.attention > 0 ? "bg-warning" : "bg-primary",
                )}
              />
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function AgentMeta(props: { readonly profile: McpGatewayProfile }) {
  return (
    <Text className="text-sm text-foreground-muted" numberOfLines={1}>
      {[
        agentModelLabel(props.profile) ?? "Default model",
        MCP_GATEWAY_RUNTIME_MODE_LABELS[props.profile.runtimeMode],
        ...(props.profile.interactionMode === "plan" ? ["Plan mode"] : []),
      ].join(" · ")}
    </Text>
  );
}

function NewChatButton(props: {
  readonly name: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`New chat with ${props.name}`}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-full px-5 py-3 active:opacity-70",
        props.disabled ? "bg-subtle" : "bg-primary",
      )}
    >
      <SymbolView
        name="square.and.pencil"
        size={15}
        tintColorClassName={props.disabled ? "accent-icon-muted" : "accent-primary-foreground"}
        type="monochrome"
      />
      <Text
        className={cn(
          "text-base font-t3-bold",
          props.disabled ? "text-foreground-muted" : "text-primary-foreground",
        )}
      >
        New chat
      </Text>
    </Pressable>
  );
}

/** The selected agent's page: who it is, how it runs, and a way to start a chat. */
function AgentHero(props: {
  readonly agent: AgentAppearance;
  readonly profile: McpGatewayProfile;
  readonly activity: AgentActivity;
  readonly unavailableReason: string | null;
  readonly onStartChat: () => void;
}) {
  return (
    <View className="mx-4 mt-4 gap-4 rounded-[22px] border border-border-subtle bg-card p-4">
      <View className="flex-row items-center gap-3">
        <AgentAvatar icon={props.agent.icon} color={props.agent.color} size={52} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-xl font-t3-bold text-foreground" numberOfLines={1}>
            {props.profile.name}
          </Text>
          <AgentMeta profile={props.profile} />
        </View>
      </View>
      {props.profile.description ? (
        <Text className="text-base leading-normal text-foreground-secondary">
          {props.profile.description}
        </Text>
      ) : null}
      <Text className="text-sm text-foreground-muted">{agentActivityLabel(props.activity)}</Text>
      <View className="gap-2">
        <NewChatButton
          name={props.profile.name}
          disabled={props.unavailableReason !== null}
          onPress={props.onStartChat}
        />
        {props.unavailableReason ? (
          <Text className="text-center text-xs text-foreground-muted">
            {props.unavailableReason}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Every agent at a glance on the All view; tapping one opens its page. */
function AgentDirectory(props: {
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly activityByProfile: ReadonlyMap<string, AgentActivity>;
  readonly unavailableReason: (profile: McpGatewayProfile) => string | null;
  readonly onSelect: (profileId: string) => void;
  readonly onStartChat: (profileId: string) => void;
}) {
  return (
    <View>
      <SectionLabel title="Agents" count={props.profiles.length} />
      <View className="mx-4 overflow-hidden rounded-[22px] border border-border-subtle bg-card">
        {props.profiles.map((profile, index) => {
          const agent = agentAppearance(profile, props.profiles);
          const reason = props.unavailableReason(profile);
          const activity = props.activityByProfile.get(profile.profileId) ?? NO_ACTIVITY;
          return (
            <View
              key={profile.profileId}
              className={cn(
                "flex-row items-center gap-3 py-3 pe-3 ps-4",
                index > 0 && "border-t border-border-subtle",
              )}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Shows this agent's chats"
                onPress={() => props.onSelect(profile.profileId)}
                className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-60"
              >
                <AgentAvatar icon={agent.icon} color={agent.color} size={40} />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                    {profile.name}
                  </Text>
                  {profile.description ? (
                    <Text className="text-sm text-foreground-secondary" numberOfLines={2}>
                      {profile.description}
                    </Text>
                  ) : null}
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {[
                      agentModelLabel(profile) ?? "Default model",
                      reason ?? agentActivityLabel(activity),
                    ].join(" · ")}
                  </Text>
                </View>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`New chat with ${profile.name}`}
                accessibilityState={{ disabled: reason !== null }}
                disabled={reason !== null}
                onPress={() => props.onStartChat(profile.profileId)}
                hitSlop={6}
                className={cn(
                  "h-10 w-10 items-center justify-center rounded-full active:opacity-60",
                  reason ? "bg-subtle opacity-50" : "bg-secondary",
                )}
              >
                <SymbolView
                  name="square.and.pencil"
                  size={16}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function PendingAgentTaskRow(props: {
  readonly task: PendingNewTask;
  readonly agent: AgentAppearance | null;
  readonly onOpen: (task: PendingNewTask) => void;
  readonly onDiscard: (task: PendingNewTask) => void;
}) {
  const { task, agent } = props;
  return (
    <View className="mx-4 my-1 flex-row items-center gap-3 rounded-[18px] border border-dashed border-border bg-card px-3.5 py-3">
      <Pressable
        accessibilityRole="button"
        onPress={() => props.onOpen(task)}
        className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
      >
        <AgentAvatar icon={agent?.icon} color={agent?.color ?? null} size={32} />
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {task.title}
          </Text>
          <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
            {[task.kind === "pending" ? "Queued" : "Draft", agent?.name]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Discard ${task.title}`}
        onPress={() => props.onDiscard(task)}
        hitSlop={8}
        className="rounded-full px-2 py-1 active:opacity-60"
      >
        <Text className="text-sm font-t3-medium text-danger-foreground">Discard</Text>
      </Pressable>
    </View>
  );
}

type AgentChatCardProps = Pick<
  ReturnType<typeof useThreadListActions>,
  "settleThread" | "unsettleThread" | "pinThread" | "unpinThread"
> & {
  readonly thread: EnvironmentThreadShell;
  readonly agent: AgentAppearance | null;
  readonly depth: number;
  readonly connected: boolean;
  readonly environmentLabel: string | undefined;
  readonly canSettle: boolean;
  readonly canPin: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
};

const AgentChatCard = memo(function AgentChatCard(props: AgentChatCardProps) {
  const { thread, agent } = props;
  const status = agentThreadStatus(thread);
  const nested = props.depth > 0;
  const onMenuAction = (action: string) => {
    if (action === "pin" || action === "unpin") {
      void (action === "unpin" ? props.unpinThread(thread) : props.pinThread(thread)).catch(
        (error) => Alert.alert("Could not pin chat", String(error)),
      );
    } else if (action === "restore") {
      props.unsettleThread(thread);
    } else if (action === "settle") {
      void props
        .settleThread(thread)
        .catch((error) => Alert.alert("Could not settle chat", String(error)));
    }
  };
  return (
    <View
      className="my-1 me-4 flex-row items-center rounded-[18px] bg-card"
      style={{ marginStart: 16 + Math.min(props.depth, 4) * 16 }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => props.onSelectThread(thread)}
        className="min-w-0 flex-1 flex-row items-center gap-3 py-3 ps-3.5 active:opacity-70"
      >
        <AgentAvatar icon={agent?.icon} color={agent?.color ?? null} size={nested ? 26 : 34} />
        <View className="min-w-0 flex-1">
          <Text
            className={cn(
              "font-t3-medium text-foreground",
              nested ? "text-sm" : "text-base",
              thread.settledAt !== null && "text-foreground-muted",
            )}
            numberOfLines={2}
          >
            {thread.title}
          </Text>
          <View className="mt-1 flex-row items-center gap-1.5">
            <View className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT_CLASS[status])} />
            <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
              {[
                agentThreadStatusLabel(status),
                agent?.name,
                props.environmentLabel,
                props.connected ? null : "Offline",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {thread.pinnedAt ? (
              <SymbolView
                name="pin"
                size={11}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            ) : null}
          </View>
        </View>
      </Pressable>
      <ControlPillMenu
        accessibilityLabel={`Actions for ${thread.title}`}
        actions={[
          thread.pinnedAt
            ? { id: "unpin", title: "Unpin", image: "pin.slash" }
            : { id: "pin", title: "Pin", image: "pin" },
          thread.settledAt
            ? { id: "restore", title: "Restore", image: "arrow.uturn.backward" }
            : { id: "settle", title: "Settle", image: "checkmark" },
        ].map((action) => ({
          ...action,
          attributes: {
            disabled:
              action.id === "pin" || action.id === "unpin" ? !props.canPin : !props.canSettle,
          },
        }))}
        onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
      >
        <View className="h-11 w-11 items-center justify-center">
          <SymbolView
            name="ellipsis"
            size={16}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </View>
      </ControlPillMenu>
    </View>
  );
});
