import type { NotificationResponse } from "expo-notifications";
import { describe, expect, it, vi } from "vite-plus/test";

import { notificationThreadPath, routeNotificationResponseOnce } from "./notificationPayload";
import { consumeLastNotificationResponse } from "./notificationResponseConsumer";

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return { notification: { request: { identifier, content: { data } } } };
}

describe("notificationThreadPath", () => {
  it("encodes the thread route from environment and thread ids", () => {
    expect(
      notificationThreadPath(responseWithData({ environmentId: "env 1", threadId: "thread/2" })),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("ignores pushes without both ids", () => {
    expect(notificationThreadPath(responseWithData({ environmentId: "env" }))).toBeNull();
    expect(
      notificationThreadPath(responseWithData({ environmentId: "", threadId: "t" })),
    ).toBeNull();
    expect(notificationThreadPath({})).toBeNull();
  });
});

describe("routeNotificationResponseOnce", () => {
  it("retries a failed cold-start tap and deduplicates it after navigation succeeds", async () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const consume = () =>
      consumeLastNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse,
        handleResponse: (response) =>
          routeNotificationResponseOnce({ handledResponseIds, response, navigate }),
      });

    await consume();
    expect(handledResponseIds.size).toBe(0);
    expect(clearLastResponse).not.toHaveBeenCalled();

    await consume();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/threads/env/thread");
    expect(clearLastResponse).toHaveBeenCalledOnce();

    routeNotificationResponseOnce({ handledResponseIds, response, navigate });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("discards malformed ids without leaving the response pending", async () => {
    const response = responseWithData({
      environmentId: "env",
      threadId: "\ud800",
    }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn();
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: (response) =>
        routeNotificationResponseOnce({ handledResponseIds, response, navigate }),
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(handledResponseIds.has("notification-1")).toBe(true);
  });
});
