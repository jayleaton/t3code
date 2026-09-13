import * as Effect from "effect/Effect";
import messageContext from "./051_ProjectionThreadMessageContext.ts";
import profileSnapshot from "./050_ProjectionThreadProfileSnapshot.ts";
import pullRequests from "./050_ProjectionThreadPullRequests.ts";

// Earlier agent builds used 50 for profiles; upstream now uses it for PR links.
// Earlier agent builds also used 51 before upstream added message context.
// Replay these idempotent additions so either upgrade path preserves existing data.
export default Effect.gen(function* () {
  yield* profileSnapshot;
  yield* pullRequests;
  yield* messageContext;
});
