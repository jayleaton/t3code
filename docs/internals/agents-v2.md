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
`1ee1d0464271295d7b389cff343c5862caf31afa` (reviewed while open on 2026-09-17),
on fork main `bff01b2d0e`. Fork PR #4 and the subsequent Agents workspace,
encryption identity, upgrade repair, loading retry, and release fixes are now in
that main baseline. The upstream history was rewritten since the earlier reviewed
`163e8e65fa8c2391f19b547ec07e360a9ce4f470`. The refresh uses that reviewed tree
as the three-way merge base, preserving separate fork-main and upstream merge
commits. Do not infer the reviewed changes from a linear upstream commit range.

Do not install this draft over an existing installation. V2's event format,
projection layout, receipt semantics, provider runtime, and client protocol are
still moving. A V1 client/server mixture is not a supported deployment. Track
upstream by fetching the PR head, recording both SHAs in the draft PR, and
reviewing the intervening changes before updating the import. Re-run copied-data
import/replay, gateway routing/grant tests, composer checks, and scoped typechecks
on every update. Revisit this decision when V2 lands instead of carrying a
permanent frozen copy of its runtime.

## Data boundary

Fork main owns migrations through 54, including its upgrade repair and title state.
The upstream V2 migration module is registered as migration **55**.
This is a fork migration history, not interchangeable with an upstream V2 database.
Tests use memory databases; integrated verification uses a read-only `VACUUM INTO`
copy in the worktree. Never experiment against the installed database.

Legacy import retains the profile snapshot. Upstream now owns the earlier draft's
event-sink and transcript-ordinal fixes: it projects shell events through the
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

The current fork Agents workspace, profile editing, machine-scoped project picker, enabled-model catalog,
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

V2 now owns durable queued runs, queued editing, worktree preparation, and draft
promotion. The fork's V1 browser-local message queue and worktree activity recovery
are superseded by those native paths; they must not be layered on top of V2.
