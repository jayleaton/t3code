#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- Standalone, opt-in migration CLI.
import * as NodeFSP from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Schema from "effect/Schema";
import {
  SkillImportManifest,
  migrateSkillResources,
  packSkillResources,
  callSkillImportTool,
} from "./skillImport.ts";

const args = process.argv.slice(2);
const manifestPath = args[0];
if (!manifestPath)
  throw new Error(
    "Usage: node packages/mcp-gateway/src/importSkills.ts manifest.json [--apply -- installed-mcp-command args...]",
  );
const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(SkillImportManifest))(
  await NodeFSP.readFile(manifestPath, "utf8"),
);
if (!args.includes("--apply")) {
  for (const entry of manifest.skills) {
    const resources = await packSkillResources(entry.directory);
    process.stdout.write(
      JSON.stringify({
        skillId: entry.skillId,
        files: resources.length,
        encodedBytes: resources.reduce((sum, file) => sum + file.contentBase64.length, 0),
      }) + "\n",
    );
  }
} else {
  const separator = args.indexOf("--");
  const command = separator < 0 ? undefined : args[separator + 1];
  if (!command)
    throw new Error("--apply requires -- followed by the installed MCP command and arguments.");
  const client = new Client({ name: "t3-skill-resource-import", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command,
      args: args.slice(separator + 2),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    }),
  );
  try {
    const tools = await client.listTools();
    const update = tools.tools.find((tool) => tool.name === "t3_update_skill");
    if (!JSON.stringify(update?.inputSchema).includes('"resources"'))
      throw new Error(
        "The installed MCP gateway does not support resources. Roll out the PR before migrating.",
      );
    const migrated = await migrateSkillResources(manifest, (name, args) =>
      callSkillImportTool(client, name, args),
    );
    process.stdout.write(JSON.stringify({ migrated }) + "\n");
  } finally {
    await client.close();
  }
}
