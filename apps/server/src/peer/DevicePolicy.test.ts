import { EnvironmentId, type DevicePolicyEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergePolicy } from "./DevicePolicy.ts";

const laptop = EnvironmentId.make("env-laptop");
const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");

const write = (
  environmentId: EnvironmentId,
  access: DevicePolicyEntry["access"],
  wallMs: number,
  counter: number,
  by: EnvironmentId,
): DevicePolicyEntry => ({
  environmentId,
  access,
  updatedAt: { wallMs, counter, node: by },
  updatedBy: by,
});

const writes = [
  write(box, "revoked", 10, 0, laptop),
  write(box, "full-access", 10, 1, studio),
  write(box, "read-only", 10, 1, laptop),
  write(studio, "auto", 5, 0, laptop),
  write(studio, "revoked", 4, 9, box),
];

const permutations = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
      );

describe("mergePolicy", () => {
  it("converges on the same policy whatever order writes arrive in", () => {
    const results = permutations(writes).map((order) =>
      // One write at a time, as gossip delivers them.
      [
        ...order.reduce<ReadonlyMap<EnvironmentId, DevicePolicyEntry>>(
          (policy, entry) => mergePolicy(policy, [entry]),
          new Map(),
        ),
      ].toSorted(([a], [b]) => a.localeCompare(b)),
    );

    for (const result of results) expect(result).toEqual(results[0]);
    expect(Object.fromEntries(results[0]!.map(([id, entry]) => [id, entry.access]))).toEqual({
      [box]: "full-access",
      [studio]: "auto",
    });
  });
});
