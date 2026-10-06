import * as Schema from "effect/Schema";
import type { McpGatewayProfile } from "@t3tools/contracts";

/**
 * What the user last picked when creating a chat from the New chat dialog.
 * Only that dialog writes it, so chats agents, MCP tools or scheduled tasks
 * create never reorder the cards. Stored per client.
 */
export const NewChatHistory = Schema.Struct({
  machine: Schema.NullOr(Schema.String),
  /** Last pick time per profileId. */
  agents: Schema.Record(Schema.String, Schema.String),
  /** Last pick time per `environmentId:projectId`. */
  projects: Schema.Record(Schema.String, Schema.String),
});
export type NewChatHistory = typeof NewChatHistory.Type;

export const emptyNewChatHistory: NewChatHistory = { machine: null, agents: {}, projects: {} };

export const newChatProjectKey = (project: {
  readonly environmentId: string;
  readonly id: string;
}) => `${project.environmentId}:${project.id}`;

/** Records a created chat's agent, machine and project as the latest picks. */
export function recordNewChat(
  history: NewChatHistory,
  chat: { profileId: string; environmentId: string; projectId: string; at: string },
): NewChatHistory {
  return {
    machine: chat.environmentId,
    agents: { ...history.agents, [chat.profileId]: chat.at },
    projects: {
      ...history.projects,
      [newChatProjectKey({ environmentId: chat.environmentId, id: chat.projectId })]: chat.at,
    },
  };
}

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

/** Most recently picked first; never-picked agents keep their board order. */
export function sortProfilesByNewChatPick<T extends Pick<McpGatewayProfile, "profileId">>(
  profiles: readonly T[],
  history: NewChatHistory,
): T[] {
  const pickedAt = (profile: T) => history.agents[profile.profileId] ?? "";
  return profiles.toSorted((a, b) => pickedAt(b).localeCompare(pickedAt(a)));
}

/** Most recently picked first; never-picked projects follow alphabetically. */
export function sortProjectsByNewChatPick<
  T extends { readonly environmentId: string; readonly id: string; readonly title: string },
>(projects: readonly T[], history: NewChatHistory): T[] {
  const pickedAt = (project: T) => history.projects[newChatProjectKey(project)] ?? "";
  return projects.toSorted(
    (a, b) => pickedAt(b).localeCompare(pickedAt(a)) || a.title.localeCompare(b.title),
  );
}

/**
 * The first `limit` choices while a grid is collapsed. A selection beyond them
 * takes the last slot so the chosen card never hides behind Show more.
 */
export function collapsedNewChatChoices<T>(
  items: readonly T[],
  isSelected: (item: T) => boolean,
  limit: number,
): readonly T[] {
  const visible = items.slice(0, limit);
  const selected = items.slice(limit).find(isSelected);
  return selected === undefined ? visible : [...visible.slice(0, limit - 1), selected];
}

/**
 * Projects whose name or path contains the query, ignoring case. A blank query
 * keeps every project, so clearing the search restores the normal list.
 */
export function filterNewChatProjects<
  T extends { readonly title: string; readonly workspaceRoot: string },
>(projects: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return projects;
  return projects.filter(
    (project) =>
      project.title.toLowerCase().includes(needle) ||
      project.workspaceRoot.toLowerCase().includes(needle),
  );
}
