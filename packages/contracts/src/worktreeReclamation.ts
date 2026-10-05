import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Explicitly reclaim the disk used by a finished thread's server-managed
 * worktree. The checkout is removed while the thread keeps its branch and
 * worktree binding, so its history stays intact and its next turn recreates
 * the checkout from the preserved branch.
 */
export const WorktreeReclaimInput = Schema.Struct({
  threadId: ThreadId,
  /** Report eligibility and the current footprint without removing anything. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type WorktreeReclaimInput = typeof WorktreeReclaimInput.Type;

export const WorktreeReclaimRefusalCode = Schema.Literals([
  "thread_not_found",
  "no_worktree",
  "not_server_managed",
  "contains_project",
  "thread_active",
  "descendant_active",
  "shared_binding",
  "live_session",
  "live_terminal",
  "branch_mismatch",
  "uncommitted_changes",
  "ignored_files",
  "unpushed",
  "unmerged",
  "changed_during_reclaim",
]);
export type WorktreeReclaimRefusalCode = typeof WorktreeReclaimRefusalCode.Type;

export const WorktreeReclaimRefusal = Schema.Struct({
  code: WorktreeReclaimRefusalCode,
  message: Schema.String,
});
export type WorktreeReclaimRefusal = typeof WorktreeReclaimRefusal.Type;

export const WorktreeReclaimResult = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * `eligible` only answers a dry run; `already_absent` means the checkout is
   * gone while the binding remains, which is the reclaimed state.
   */
  status: Schema.Literals(["eligible", "reclaimed", "refused", "already_absent"]),
  /** Every reason the checkout is kept. Empty unless `status` is `refused`. */
  refusals: Schema.Array(WorktreeReclaimRefusal),
  /** Allocated bytes on disk (not logical size); null when it could not be measured. */
  allocatedBytesBefore: Schema.NullOr(NonNegativeInt),
  allocatedBytesAfter: Schema.NullOr(NonNegativeInt),
});
export type WorktreeReclaimResult = typeof WorktreeReclaimResult.Type;

export class WorktreeReclaimError extends Schema.TaggedError<WorktreeReclaimError>()(
  "WorktreeReclaimError",
  { message: Schema.String },
) {}
