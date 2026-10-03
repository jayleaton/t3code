import compatibility from "./052_AgentProfileAndPullRequestCompatibility.ts";

// Shipped agent builds recorded 52 as ProjectionThreadListState. Their ledger
// skips our 52 compatibility repair, including the upstream message context.
export default compatibility;
