# Command Code

Install Command Code on the machine running your T3 environment with
`npm install -g command-code`, then sign in with `commandcode login`. Enable
**Command Code** in **Settings > Providers**. If it is outside your PATH, set its
**Binary path**. Use a current CLI with JSON output support; this integration was
verified against 1.58.0. The `commandcode` executable avoids the Windows `cmd.exe`
name collision.

Choose **Command Code default** to use the CLI's configured model, or select a
model from its installed catalog. Additional provider instances can use their own
binary path and environment variables, including `COMMAND_CODE_API_KEY`.
Credentials and processes stay on the environment; web, desktop, and mobile
clients can send follow-ups and stop turns through the normal chat controls.

Command Code's headless interface cannot answer interactive approval requests.
Normal sessions deny actions requiring approval. **Full Access** explicitly
allows those actions without prompting. **Plan** mode remains read-only even
with Full Access selected. Auto-accept edits follows the CLI's own headless
permission rules; it does not enable interactive approvals.

Follow-ups resume the exact Command Code session. Attachments, manual compaction,
conversation rollback, and interactive question cards are not supported by this
integration. Reference workspace file paths in your prompt instead of attaching
files. Command Code reads its own configured skills and MCP servers; T3's
per-thread MCP tools are not injected into it.

Command Code’s headless CLI has a model-request limit per turn. If it reaches that limit, the thread retains its output and native session; send a follow-up to continue. If the agent was repeatedly attempting an unavailable tool, address that limitation before continuing. T3 does not inject its per-thread MCP tools into Command Code, so PR URLs can be returned in chat without automatic thread linking.
