# Import supporting files for existing skills

Roll out skill-resource support to the MCP gateway, clients, and destination environments first.
Do not run a development server against an installed T3 home to migrate data.

Create a private JSON manifest outside the repository. Map each existing skill ID (from
`t3_list_skills`) to its original folder; folder names need not match skill names:

```json
{
  "environmentId": "your-environment-id",
  "skills": [{ "skillId": "existing-skill-id", "directory": "/path/to/original-skill" }]
}
```

From a checkout with dependencies installed, validate and inventory the files without contacting T3:

```sh
node packages/mcp-gateway/src/importSkills.ts /path/to/manifest.json
```

Review the source folders before uploading. All regular files except the root `SKILL.md`, `.git`,
`.DS_Store`, `node_modules`, and `__pycache__` are packaged. Symlinks, special files, invalid paths,
case-insensitive collisions, and oversized files/bundles are rejected. Script execute bits are
preserved; no scripts or generation tools run during import. Keep credentials out of skill folders.

After rollout, pass the **installed** MCP command and its arguments from your harness configuration.
Use its existing environment variables for authentication; do not put credentials in command arguments:

```sh
node packages/mcp-gateway/src/importSkills.ts /path/to/manifest.json --apply -- /path/to/installed/t3-mcp-gateway
```

The utility requires read and create/admin access. It checks that the installed gateway exposes
resources, updates existing skills, and reads back every resource byte and executable flag. Only then
does it remove a recognized `Supporting resources in T3` workaround pointing at the manifest's
folder. It preserves the rest of the current instructions, unrelated skills, skill IDs, and agent
assignments. Unknown workaround text stops migration for review. A failure can leave earlier skills
migrated; rerunning the same manifest is supported. Avoid concurrent edits during migration.

The utility verifies the selected environment. MCP reports replication failures separately; connect
and update destination environments, then use `t3_list_skills` there to verify synchronization before
starting new chats. Existing chats intentionally retain their original snapshots; start new chats to
use imported resources. Do not delete the original folders until every required destination has the
files and new chats have been verified.
