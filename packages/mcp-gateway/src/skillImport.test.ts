import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpGateway } from "./server.ts";
import type { GatewayRuntimePort } from "./port.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Test standalone import filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { migrateSkillResources, packSkillResources, callSkillImportTool } from "./skillImport.ts";
import { AgentSkill, AgentSkillResources } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeSkill = Schema.decodeUnknownSync(AgentSkill);

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-import-"));
  await NodeFSP.mkdir(NodePath.join(root, "scripts"));
  await NodeFSP.mkdir(NodePath.join(root, "references/deep"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "assets"));
  await NodeFSP.writeFile(
    NodePath.join(root, "SKILL.md"),
    "# Task\nRead references/deep/rules.md.",
  );
  await NodeFSP.writeFile(NodePath.join(root, "scripts/check.sh"), "#!/bin/sh\nprintf ok\n", {
    mode: 0o755,
  });
  await NodeFSP.writeFile(NodePath.join(root, "references/deep/rules.md"), "Rules: café\n");
  await NodeFSP.writeFile(NodePath.join(root, "assets/pixel.bin"), Buffer.from([0, 255, 128, 255]));
  return root;
}

describe("supported resource migration", () => {
  it("preserves nested file bytes and executable metadata, rejecting symlinks", async () => {
    const root = await fixture();
    try {
      const files = await packSkillResources(root);
      expect(files.map((file) => file.path)).toEqual([
        "assets/pixel.bin",
        "references/deep/rules.md",
        "scripts/check.sh",
      ]);
      for (const file of files)
        expect(Buffer.from(file.contentBase64, "base64")).toEqual(
          await NodeFSP.readFile(NodePath.join(root, file.path)),
        );
      expect(files.at(-1)?.executable).toBe(true);
      await NodeFSP.symlink(
        NodePath.join(root, "SKILL.md"),
        NodePath.join(root, "references/link"),
      );
      await expect(packSkillResources(root)).rejects.toThrow("symlink");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it.each([true, false])(
    "removes workaround only after persisted read-back (supported=%s)",
    async (supported) => {
      const root = await fixture();
      const content = `# Start\n\n## Supporting resources in T3\n\nSupporting files remain in the original skill directory: \`${root}\`. T3 syncs this text, not those files.\n\n# Work\nRead references/deep/rules.md.\n`;
      let skill: AgentSkill = {
        skillId: "existing",
        name: "Existing",
        description: "Test",
        content,
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
      };
      const calls: string[] = [];
      const decodePatch = Schema.decodeUnknownSync(
        Schema.Struct({
          resources: Schema.optionalKey(AgentSkillResources),
          content: Schema.optionalKey(Schema.String),
        }),
      );
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const gateway = createMcpGateway({
          grants: { local: ["read", "create"] },
          port: {
            listEnvironments: async () => [],
            listSkills: async () => {
              calls.push("t3_list_skills");
              return [skill];
            },
            updateSkill: async (_environmentId: string, id: string, patch: unknown) => {
              calls.push("t3_update_skill");
              expect(id).toBe("existing");
              skill = decodeSkill({
                ...skill,
                ...decodePatch(patch),
                ...(supported ? {} : { resources: [] }),
                revision: skill.revision + 1,
              });
              return skill;
            },
          } as unknown as GatewayRuntimePort,
        });
        const client = new Client({ name: "migration-test", version: "1.0.0" });
        await gateway.connect(serverTransport);
        await client.connect(clientTransport);
        const migrate = () =>
          migrateSkillResources(
            { environmentId: "local", skills: [{ skillId: skill.skillId, directory: root }] },
            (name, args) => callSkillImportTool(client, name, args),
          );
        try {
          if (supported) {
            await migrate();
            expect(skill.content).not.toContain("Supporting resources in T3");
            expect(skill.content).toContain("Read references/deep/rules.md.");
            expect(skill.resources).toHaveLength(3);
            await migrate(); // Resumable without re-creating skills or changing assignments.
          } else {
            await expect(migrate()).rejects.toThrow("not retained");
            expect(skill.content).toBe(content.trim());
          }
          expect(
            calls.every((name) => name === "t3_list_skills" || name === "t3_update_skill"),
          ).toBe(true);
        } finally {
          await client.close();
          await gateway.close();
        }
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
