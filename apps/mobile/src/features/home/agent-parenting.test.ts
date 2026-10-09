import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parentRejection, resolveParentDrop } from "./agent-parenting";

const run = (id: string, parentThreadId: string | null = null) => ({
  environmentId: EnvironmentId.make("env"),
  id: ThreadId.make(id),
  parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
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

  it("rejects a card the chat can never move under instead of detaching", () => {
    expect(
      resolveParentDrop({
        draggedKey: "env:a",
        currentParentKey: "env:c",
        pointerY: 150,
        cards,
        linkTargets: new Set<string>(),
      }),
    ).toEqual({ kind: "rejected", targetKey: "env:b" });
  });
});

describe("parentRejection", () => {
  const all = [run("a"), run("b", "a"), run("c", "b"), run("d")].map((thread) => ({
    ...thread,
    title: `chat ${thread.id}`,
  }));

  it("allows a valid move", () => {
    expect(parentRejection(all[3]!, all[0]!, all)).toBeNull();
  });

  it("rejects self-parenting, the current parent, and cycles with the shared wording", () => {
    expect(parentRejection(all[0]!, all[0]!, all)).toBe("A chat cannot be its own parent");
    expect(parentRejection(all[2]!, all[1]!, all)).toBe("Already under chat b");
    expect(parentRejection(all[0]!, all[2]!, all)).toBe("Can't move under its own child");
  });
});
