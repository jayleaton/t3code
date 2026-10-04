import { useAtom, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  mergeAgentLibraries,
  type EnvironmentId,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import {
  agentThreadStatus,
  agentThreadStatusLabel,
  excludePinnedAgentThreads,
  nestAgentRuns,
  selectAgentWorkspaceThreads,
  selectPinnedAgentThreads,
} from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveGatewayProfileModelSelection } from "@t3tools/client-runtime/gateway";
import { ControlPillMenu } from "../../components/ControlPill";
import { AppText as Text } from "../../components/AppText";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { agentsBoardSelectionAtom } from "./agents-board-state";

export function WorkspaceBoardTabs() {
  const [selection, setSelection] = useAtom(agentsBoardSelectionAtom);
  return (
    <View accessibilityRole="tablist" className="flex-row gap-2 px-4 py-3">
      {(["agents", "threads"] as const).map((tab) => (
        <Pressable
          key={tab}
          accessibilityRole="tab"
          accessibilityState={{ selected: selection.tab === tab }}
          onPress={() => setSelection({ ...selection, tab })}
          className={
            selection.tab === tab
              ? "rounded-full bg-primary px-5 py-2"
              : "rounded-full bg-card px-5 py-2"
          }
        >
          <Text
            className={
              selection.tab === tab ? "font-t3-bold text-primary-foreground" : "text-foreground"
            }
          >
            {tab === "agents" ? "Agents" : "Threads"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
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
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useAtom(agentsBoardSelectionAtom);
  const [settledOpen, setSettledOpen] = useState(false);
  const { settleThread, unsettleThread, pinThread, unpinThread } = useThreadListActions();
  const pending = usePendingNewTasks();
  const { confirmDeletePendingTask } = usePendingTaskListActions();
  const profiles = useMemo(
    () =>
      mergeAgentLibraries([...configs.values()].map((config) => config.settings))
        .mcpGatewayProfiles,
    [configs],
  );
  const profileId = profiles.some((profile) => profile.profileId === selection.profileId)
    ? selection.profileId
    : null;
  const scoped = useMemo(
    () =>
      threads.filter(
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
  const board = useMemo(() => {
    const pinned = selectPinnedAgentThreads(
      scoped.filter((thread) => thread.profileSnapshot?.profileId),
    );
    const { active, settled } = selectAgentWorkspaceThreads(scoped, profileId, props.searchQuery);
    return nestAgentRuns({
      lists: { pinned, active: excludePinnedAgentThreads(active, pinned), settled },
      all: scoped,
    });
  }, [scoped, profileId, props.searchQuery]);
  const rows = useMemo(() => {
    const append = (items: readonly EnvironmentThreadShell[], section: string) =>
      items.flatMap((thread) => {
        const children = board.childrenByKey.get(`${thread.environmentId}:${thread.id}`);
        return [
          { thread, depth: 0, section },
          ...(children?.live ?? []).map((child) => ({
            ...child,
            depth: child.depth + 1,
            section: "Sub-run",
          })),
          ...(settledOpen
            ? (children?.settled ?? []).map((child) => ({
                ...child,
                depth: child.depth + 1,
                section: "Settled sub-run",
              }))
            : []),
        ];
      });
    return [
      ...append(board.lists.pinned, "Pinned"),
      ...append(board.lists.active, ""),
      ...(settledOpen ? append(board.lists.settled, "Settled") : []),
    ];
  }, [board, settledOpen]);
  const jumpItems = useMemo(
    () => rows.map(({ thread }) => ({ type: "agent-thread" as const, thread })),
    [rows],
  );
  useThreadJumpShortcuts(jumpItems, props.onSelectThread);
  const scopedPending = pending.filter(
    (task) =>
      Boolean(
        task.kind === "pending" ? task.creation.profileSelection : task.draft.profileSelection,
      ) &&
      (profileId === null ||
        (task.kind === "pending" ? task.creation.profileSelection : task.draft.profileSelection)
          ?.profileId === profileId) &&
      (props.environmentId === null || task.environmentId === props.environmentId) &&
      (!props.projectRefs ||
        props.projectRefs.some(
          (ref) => ref.environmentId === task.environmentId && ref.projectId === task.projectId,
        )) &&
      task.title.toLocaleLowerCase().includes(props.searchQuery.trim().toLocaleLowerCase()),
  );
  const hiddenSettledCount =
    board.lists.settled.length +
    [...board.childrenByKey.values()].reduce(
      (count, children) => count + children.settled.length,
      0,
    );

  const canStart = (profile: McpGatewayProfile) =>
    profile.runtimeMode !== "read-only" &&
    environments.some(
      (environment) =>
        environment.connection.phase === "connected" &&
        (props.environmentId === null || environment.environmentId === props.environmentId) &&
        (!profile.environmentIds?.length ||
          profile.environmentIds.includes(environment.environmentId)) &&
        environment.serverConfig?.settings.mcpGatewayProfiles.some(
          (candidate) =>
            candidate.profileId === profile.profileId && candidate.revision === profile.revision,
        ) &&
        resolveGatewayProfileModelSelection(profile, environment.serverConfig.providers),
    );
  const startChat = (id: string) => props.onStartAgentChat(id, props.environmentId);
  const selectedProfile = profiles.find((profile) => profile.profileId === profileId);
  const renderRow = useCallback(
    ({ item }: { item: (typeof rows)[number] }) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === item.thread.environmentId,
      );
      const connected = environment?.connection.phase === "connected";
      const capabilities = configs.get(item.thread.environmentId)?.environment.capabilities;
      return (
        <AgentChatCard
          {...item}
          connected={connected}
          environmentLabel={environment?.label}
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
      environments,
      configs,
      props.onSelectThread,
      settleThread,
      unsettleThread,
      pinThread,
      unpinThread,
    ],
  );
  return (
    <LegendList
      style={{ flex: 1 }}
      data={rows}
      keyExtractor={({ thread }) => `${thread.environmentId}:${thread.id}`}
      estimatedItemSize={100}
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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
          >
            {[{ profileId: null, name: "All" }, ...profiles].map((profile) => (
              <Pressable
                key={profile.profileId ?? "all"}
                accessibilityRole="button"
                accessibilityState={{ selected: profileId === profile.profileId }}
                onPress={() => setSelection({ ...selection, profileId: profile.profileId })}
                className="rounded-xl bg-card px-4 py-3"
              >
                <View className="flex-row items-center gap-2">
                  {profile.profileId && "color" in profile && profile.color ? (
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: profile.color,
                      }}
                    />
                  ) : null}
                  <Text
                    className={
                      profileId === profile.profileId
                        ? "font-t3-bold text-primary"
                        : "text-foreground"
                    }
                  >
                    {profile.name}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          {selectedProfile ? (
            <View className="mx-4 mt-3">
              {selectedProfile.description ? (
                <Text className="mb-2 text-sm text-foreground-muted">
                  {selectedProfile.description}
                </Text>
              ) : null}
              <Pressable
                disabled={!canStart(selectedProfile)}
                accessibilityRole="button"
                onPress={() => startChat(selectedProfile.profileId)}
                className="rounded-xl bg-card px-4 py-3"
              >
                <Text
                  className={
                    canStart(selectedProfile)
                      ? "font-t3-bold text-primary"
                      : "text-foreground-muted"
                  }
                >
                  {canStart(selectedProfile)
                    ? `New chat with ${selectedProfile.name}`
                    : `${selectedProfile.name} unavailable`}
                </Text>
              </Pressable>
            </View>
          ) : profiles.length > 0 ? (
            <ControlPillMenu
              accessibilityLabel="New agent chat"
              actions={profiles.map((profile) => ({
                id: profile.profileId,
                title: profile.name,
                attributes: { disabled: !canStart(profile) },
              }))}
              onPressAction={({ nativeEvent }) => startChat(nativeEvent.event)}
              className="mx-4 mt-3"
            >
              <View className="rounded-xl bg-card px-4 py-3">
                <Text className="font-t3-bold text-primary">New agent chat</Text>
              </View>
            </ControlPillMenu>
          ) : null}
          {profiles.length === 0 ? (
            <Text className="px-4 py-4 text-foreground-muted">
              No agents yet. Configure agents on web or desktop in a connected environment.
            </Text>
          ) : null}
          {scopedPending.map((task) => (
            <Pressable
              key={task.key}
              accessibilityRole="button"
              onPress={() => props.onSelectPendingTask(task)}
              className="mx-4 mt-3 rounded-xl bg-card p-4"
            >
              <Text>
                {task.title} · {task.kind === "pending" ? "Queued" : "Draft"}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => confirmDeletePendingTask(task)}>
                <Text className="mt-2 text-primary">Discard</Text>
              </Pressable>
            </Pressable>
          ))}
          {hiddenSettledCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: settledOpen }}
              onPress={() => setSettledOpen(!settledOpen)}
              className="px-4 py-3"
            >
              <Text className="text-foreground-muted">
                {settledOpen ? "Hide" : "Show"} settled ({hiddenSettledCount})
              </Text>
            </Pressable>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <Text className="px-4 py-6 text-foreground-muted">
          {props.searchQuery.trim()
            ? "No matching agent chats."
            : "No active agent chats. Choose an agent to start a chat."}
        </Text>
      }
      renderItem={renderRow}
    />
  );
}

type AgentChatCardProps = Pick<
  ReturnType<typeof useThreadListActions>,
  "settleThread" | "unsettleThread" | "pinThread" | "unpinThread"
> & {
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
  readonly section: string;
  readonly connected: boolean;
  readonly environmentLabel: string | undefined;
  readonly canSettle: boolean;
  readonly canPin: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
};

const AgentChatCard = memo(function AgentChatCard(props: AgentChatCardProps) {
  const { thread } = props;
  return (
    <View
      className="mx-4 my-1 rounded-xl bg-card p-4"
      style={{ marginLeft: 16 + Math.min(props.depth, 4) * 12 }}
    >
      <Pressable accessibilityRole="button" onPress={() => props.onSelectThread(thread)}>
        <Text className="text-xs text-foreground-muted">
          {[props.section, thread.profileSnapshot?.profileName, props.environmentLabel]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <Text className="font-t3-bold text-foreground">{thread.title}</Text>
        <Text className="text-sm text-foreground-muted">
          {agentThreadStatusLabel(agentThreadStatus(thread))}
          {props.connected ? "" : " · Offline"}
        </Text>
      </Pressable>
      <View className="mt-3 flex-row gap-4">
        <Pressable
          accessibilityRole="button"
          disabled={!props.canSettle}
          onPress={() => {
            if (thread.settledAt) props.unsettleThread(thread);
            else
              void props
                .settleThread(thread)
                .catch((error) => Alert.alert("Could not settle chat", String(error)));
          }}
        >
          <Text className={props.canSettle ? "text-primary" : "text-foreground-muted"}>
            {thread.settledAt ? "Restore" : "Settle"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!props.canPin}
          onPress={() => {
            void (thread.pinnedAt ? props.unpinThread(thread) : props.pinThread(thread)).catch(
              (error) => Alert.alert("Could not pin chat", String(error)),
            );
          }}
        >
          <Text className={props.canPin ? "text-primary" : "text-foreground-muted"}>
            {thread.pinnedAt ? "Unpin" : "Pin"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});
