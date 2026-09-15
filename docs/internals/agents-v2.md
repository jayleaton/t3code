# Agents on orchestrator V2 (experimental)

The Agents board is a profile-indexed view of native V2 threads. It must not own
another run state machine, provider process, event log, or transcript. A profile
is a settings record; creation resolves its revision and freezes its instructions
on the native thread. Later library edits affect new threads only. The common
provider turn boundary supplies these instructions, including after a provider
switch. This draft supplies them as a delimited prompt prefix, not as a native
provider system/developer message; provider-specific instruction priority still
needs acceptance testing.

## Prerequisites and upstream movement

This draft imports pingdotgg/t3code#2829 at
`163e8e65fa8c2391f19b547ec07e360a9ce4f470` (reviewed while open), on fork main
`57fa730c5103ca7f57dfec0db5bfb10cc4fae561`. Fork PR #4 at
`95defded7d8a819c0dd30a71f37c44f98d08bccf` is merged separately as a prerequisite;
its branch remains independently reviewable. A later fetch found upstream at
`c2dbc35d71c056ca49e93114bb9534f366084fd6` with rewritten ancestry and 120 changed
files against the reviewed tree (mostly worktree setup, titles, and navigation).
That movement is not imported here; compare trees/range-diffs before updating,
not just a linear commit range. The legacy-import fix remains needed in that tree. The upstream import is its own
merge commit; the subsequent Agents commit is the functional adaptation.

Do not install this draft over an existing installation. V2's event format,
projection layout, receipt semantics, provider runtime, and client protocol are
still moving. A V1 client/server mixture is not a supported deployment. Track
upstream by fetching the PR head, recording both SHAs in the draft PR, and
reviewing the intervening changes before updating the import. Re-run copied-data
import/replay, gateway routing/grant tests, composer checks, and scoped typechecks
on every update. Revisit this decision when V2 lands instead of carrying a
permanent frozen copy of its runtime.

## Data boundary

Fork main already owns migration 52. The unchanged upstream V2 migration module
is registered as migration **53**, after the fork's compatibility migration 52.
This is a fork migration history, not interchangeable with an upstream V2 database.
Tests use memory databases; integrated verification uses a read-only `VACUUM INTO`
copy in the worktree. Never experiment against the installed database.

Legacy import retains the profile snapshot and projects shell events through the
native event sink. Reserve legacy transcript ordinals before writing those events:
normalizing the first/last preview messages first consumes ordinals needed by the
subsequent full transcript. The import regression checks visibility before replay
and preservation after replay. Data produced by earlier exploratory versions of
this branch is disposable; recreate its sandbox from the V1 snapshot.

## Client MCP is a separate boundary

V2's MCP HTTP server and toolkits serve one environment's provider invocation.
They do not have the client's authorized connection registry and cannot replace
the client-facing gateway. Retain `packages/mcp-gateway`, its durable delivery and
grant checks, and the client/desktop bridge. The runtime port adapts this gateway
to native V2 queries, commands, runtime requests, and receipts. Environment ID is
required for routing; a project or thread ID alone is never globally unique.
Readable provider/model labels are resolved against the target environment's
catalog. The gateway never creates a broader grant to compensate for routing.

`t3_get_agents_view` lists profiles with associated chats and accepts `profileId`
and settlement filters. Native run IDs are available on thread summaries and
native run records on thread detail. Gateway events are bounded shell changes
with environment-qualified IDs. This changes the old activity-event vocabulary;
external consumers must not assume V1 session/activity payloads survive.

Pause/cancel map to native interruption; stop detaches the native runtime session;
resume/retry create a native continuation message and restart requests restart
semantics. These are compatibility mappings, not a new persisted lifecycle.
Individual native runtime requests can be answered. V1 atomic approval-plan
modification is unsupported and fails explicitly; do not emulate atomicity by
sequentially granting approvals.

## Reuse and retained fork surface

The board, profile editing, machine-scoped project picker, enabled-model catalog,
and client gateway remain fork UI/application concerns. Embedded new/hover chats
render the same V2 composer as normal chat, including attachments and model
controls. Native projections provide status, transcript, PR links, and settlement.
Native settlement rechecks all eligible associated chats after a merge, retaining
upstream protections for active, pinned, or explicitly unsettled work.

The old local workspace MCP toolkit, V1 lifecycle/approval-batch orchestration,
and provider-specific profile instruction files are superseded. Keep the profile
snapshot, profile revision/tombstone settings merge, client grant/delivery store,
and machine-aware navigation. Desktop branding, fork release feed, bundled build
version, and branded startup route remain independent of orchestration. Official
T3 Connect/auth/relay configuration is retained; this draft requires no fork cloud.
