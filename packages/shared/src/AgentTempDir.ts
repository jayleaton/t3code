import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface AgentTempDirShape {
  /**
   * Environment entries that point a thread's agent process, and every tool it runs, at a
   * disk-backed temp directory owned by that thread. Merge them over the spawn environment.
   * Empty where the server does not redirect temp files (Windows, tests).
   */
  readonly environment: (input: {
    readonly threadId: string;
    readonly cwd: string | undefined;
  }) => Effect.Effect<Readonly<Record<string, string>>>;
}

export const AgentTempDir = Context.Reference<AgentTempDirShape>("@t3tools/shared/AgentTempDir", {
  defaultValue: () => ({ environment: () => Effect.succeed({}) }),
});
