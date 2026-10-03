import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AgentSkillResources, MAX_SKILL_RESOURCE_BYTES } from "./agentSkills.ts";
const decode = Schema.decodeUnknownSync(AgentSkillResources);
const file = (path: string, contentBase64 = "aGVsbG8=") => ({ path, contentBase64 });
describe("portable skill resources", () => {
  it("accepts nested scripts, binary assets, empty files and executable metadata", () => {
    const resources = [
      file("references/nested/rules.md"),
      { ...file("scripts/check.sh"), executable: true },
      file("assets/pixel.png", "AP+A/w=="),
      file("assets/empty", ""),
    ];
    expect(decode(JSON.parse(JSON.stringify(resources)))).toEqual(resources);
  });
  it.each([
    "../escape",
    "/absolute",
    "C:/file",
    "a\\b",
    "a/../b",
    "./file",
    "a//b",
    "a/",
    "SKILL.md",
    "skill.md/file",
    ".git/config",
    "a\u0000b",
    "a:stream",
    "CON",
    "aux.txt",
    "a. ",
  ])("rejects unsafe path %s", (path) => {
    expect(() => decode([file(path)])).toThrow();
  });
  it.each(["!", "AA", "aGVsbG8=\n", "AB==", "AAB="])("rejects malformed base64 %s", (value) => {
    expect(() => decode([file("asset", value)])).toThrow();
  });
  it("rejects collisions, prefix overlap and oversized bundles", () => {
    for (const paths of [
      ["a", "a"],
      ["A", "a"],
      ["a", "a/b"],
      ["é", "e\u0301"],
    ])
      expect(() => decode(paths.map((path) => file(path)))).toThrow();
    const large = "AAAA".repeat(Math.floor(MAX_SKILL_RESOURCE_BYTES / 3)) + "AA==";
    expect(() =>
      decode([file("a", "AAAA".repeat(Math.floor(MAX_SKILL_RESOURCE_BYTES / 3)) + "AAA=")]),
    ).toThrow();
    expect(() => decode([file("a", large), file("b", large), file("c", large)])).toThrow();
  });
});
