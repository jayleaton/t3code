import { isSubagentThread, type McpGatewayProfile } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Agent the New chat dialog starts on: Captain when it can start chats, else the first that can. */
export function defaultNewChatProfile(
  profiles: readonly McpGatewayProfile[],
): McpGatewayProfile | undefined {
  const startable = profiles.filter((profile) => profile.runtimeMode !== "read-only");
  return (
    startable.find((profile) => profile.name.trim().toLowerCase() === "captain") ?? startable[0]
  );
}

/** The machine the last new chat was created on when it can still run this agent, else the first that can. */
export function defaultNewChatMachine(
  eligibleEnvironmentIds: readonly string[],
  lastEnvironmentId: string | null,
): string {
  if (lastEnvironmentId !== null && eligibleEnvironmentIds.includes(lastEnvironmentId)) {
    return lastEnvironmentId;
  }
  return eligibleEnvironmentIds[0] ?? "";
}

/**
 * Orders projects by when a chat was last created in them, newest first, so
 * the project a user keeps starting chats in sits top-left. Messages and other
 * activity do not count, and neither do subagents an agent spawned itself.
 * Projects without chats follow alphabetically.
 */
export function sortProjectsByNewChatRecency<
  T extends { readonly environmentId: string; readonly id: string; readonly title: string },
>(
  projects: readonly T[],
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "environmentId"
      | "projectId"
      | "createdAt"
      | "parentThreadId"
      | "parentRelationship"
      | "lineage"
    >
  >,
): T[] {
  const latest = new Map<string, string>();
  for (const thread of threads) {
    if (isSubagentThread(thread)) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const current = latest.get(key);
    if (current === undefined || thread.createdAt > current) latest.set(key, thread.createdAt);
  }
  const createdAt = (project: T) => latest.get(`${project.environmentId}:${project.id}`) ?? "";
  return projects.toSorted(
    (a, b) => createdAt(b).localeCompare(createdAt(a)) || a.title.localeCompare(b.title),
  );
}
