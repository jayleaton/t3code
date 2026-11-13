type UnknownRecord = Record<string, unknown>;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as UnknownRecord)[key] : undefined;
}

function notificationRequest(response: unknown): unknown {
  return field(field(response, "notification"), "request");
}

function encodeThreadPath(environmentId: string, threadId: string): string | null {
  if (environmentId.length === 0 || threadId.length === 0) return null;
  try {
    return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  } catch {
    return null;
  }
}

export function threadPathOnScreen(pathname: string): string | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return `/threads/${match[1]}/${match[2]}`;
}

/** The thread a server push points at, from its `data.environmentId` and `data.threadId`. */
export function notificationThreadPath(response: unknown): string | null {
  const data = field(field(notificationRequest(response), "content"), "data");
  const environmentId = field(data, "environmentId");
  const threadId = field(data, "threadId");
  return typeof environmentId === "string" && typeof threadId === "string"
    ? encodeThreadPath(environmentId, threadId)
    : null;
}

export function routeNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (path: string) => void;
}): void {
  const identifier = field(notificationRequest(input.response), "identifier");
  const responseId = typeof identifier === "string" ? identifier : null;
  if (responseId && input.handledResponseIds.has(responseId)) return;
  const path = notificationThreadPath(input.response);
  if (path) input.navigate(path);
  if (responseId) input.handledResponseIds.add(responseId);
}
