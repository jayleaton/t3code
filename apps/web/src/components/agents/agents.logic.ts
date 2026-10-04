export * from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * Opens a run's menu. Children pass their siblings so Move up/down arranges
 * them within their parent instead of the board.
 */
export type AgentRunContextMenu = (
  thread: EnvironmentThreadShell,
  position: { x: number; y: number },
  siblings?: readonly EnvironmentThreadShell[],
) => Promise<void>;
