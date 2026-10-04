import { describe, expect, it } from "vitest";

import {
  applyPendingParents,
  parentRejection,
  pendingParentSettled,
  resolveParentDrop,
} from "./agent-parenting";

const run = (id: string, parentThreadId: string | null = null, environmentId = "env") => ({
  environmentId,
  id,
  parentThreadId,
});

const cards = [
  { key: "env:a", top: 0, bottom: 100 },
  { key: "env:b", top: 110, bottom: 210 },
  { key: "env:c", top: 220, bottom: 320 },
];

describe("resolveParentDrop", () => {
  it("nests over a card the chat may move under", () => {
    expect(
      resolveParentDrop({
        draggedKey: "env:a",
        currentParentKey: null,
        pointerY: 150,
        cards,
        linkTargets: new Set(["env:b", "env:c"]),
      }),
    ).toEqual({ kind: "nest", parentKey: "env:b" });
  });

  it("does nothing over its own card or its current parent", () => {
    const base = {
      draggedKey: "env:c",
      currentParentKey: "env:b",
      cards,
      linkTargets: new Set(["env:a"]),
    };
    expect(resolveParentDrop({ ...base, pointerY: 250 })).toEqual({ kind: "none" });
    expect(resolveParentDrop({ ...base, pointerY: 150 })).toEqual({ kind: "none" });
  });

  it("detaches a child released away from any target, and leaves top-level chats alone", () => {
    const base = { draggedKey: "env:c", cards, linkTargets: new Set<string>() };
    expect(resolveParentDrop({ ...base, currentParentKey: "env:b", pointerY: 500 })).toEqual({
      kind: "detach",
    });
    expect(resolveParentDrop({ ...base, currentParentKey: null, pointerY: 500 })).toEqual({
      kind: "none",
    });
  });

  it("re-parents a child onto a different parent", () => {
    expect(
      resolveParentDrop({
        draggedKey: "env:c",
        currentParentKey: "env:b",
        pointerY: 50,
        cards,
        linkTargets: new Set(["env:a"]),
      }),
    ).toEqual({ kind: "nest", parentKey: "env:a" });
  });
});

describe("parentRejection", () => {
  const all = [run("a"), run("b", "a"), run("c", "b"), run("d")];

  it("allows a valid move", () => {
    expect(parentRejection(all[3]!, all[0]!, all)).toBeNull();
  });

  it("rejects self-parenting, the current parent, and cycles", () => {
    expect(parentRejection(all[0]!, all[0]!, all)).toBe("A chat can't be its own parent.");
    expect(parentRejection(all[2]!, all[1]!, all)).toBe("It's already a child of that chat.");
    expect(parentRejection(all[0]!, all[2]!, all)).toBe(
      "A chat can't move under one of its own child chats.",
    );
  });
});

describe("pending parents", () => {
  it("shows the optimistic parent until the shell confirms it", () => {
    const pending = new Map([["env:d", { parentThreadId: "a", parentEnvironmentId: null }]]);
    const [, , , d] = applyPendingParents([run("a"), run("b"), run("c"), run("d")], pending);
    expect(d?.parentThreadId).toBe("a");
    expect(pendingParentSettled(run("d"), pending.get("env:d")!)).toBe(false);
    expect(pendingParentSettled(run("d", "a"), pending.get("env:d")!)).toBe(true);
  });

  it("treats a cleared parent as settled once the shell has none", () => {
    const clear = { parentThreadId: null, parentEnvironmentId: null };
    expect(pendingParentSettled(run("d", "a"), clear)).toBe(false);
    expect(pendingParentSettled(run("d"), clear)).toBe(true);
  });
});
