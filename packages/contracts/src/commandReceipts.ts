import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/** Outcome of one dispatched command, read back by the MCP gateway to confirm delivery. */
export const OrchestrationCommandReceiptRecord = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.Literals(["project", "thread"]),
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceiptRecord = typeof OrchestrationCommandReceiptRecord.Type;

export const OrchestrationGetCommandReceiptsInput = Schema.Struct({
  commandIds: Schema.Array(CommandId).check(Schema.isMaxLength(100)),
});
export type OrchestrationGetCommandReceiptsInput = typeof OrchestrationGetCommandReceiptsInput.Type;

export const OrchestrationGetCommandReceiptsResult = Schema.Struct({
  receipts: Schema.Array(OrchestrationCommandReceiptRecord),
});
export type OrchestrationGetCommandReceiptsResult =
  typeof OrchestrationGetCommandReceiptsResult.Type;
