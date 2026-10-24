import compatibility from "./001_AgentProfileAndPullRequestCompatibility.ts";

// Shipped agent builds recorded 52 as ProjectionThreadListState. Their ledger
// skips fork migration 1, including the upstream message context.
export default compatibility;
