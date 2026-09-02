import type { GatewayRuntimePort } from "./port.ts";

export interface GatewayRuntimeHandle {
  stop(): Promise<void>;
}

export interface GatewayRuntimeModule {
  start(port: GatewayRuntimePort): Promise<GatewayRuntimeHandle>;
}

export type GatewayStatus =
  | { readonly state: "disabled" }
  | { readonly state: "starting" }
  | { readonly state: "running" }
  | { readonly state: "degraded"; readonly message: string };

export function createGatewayController(input: {
  readonly port: GatewayRuntimePort;
  readonly load: () => Promise<GatewayRuntimeModule>;
}) {
  let current: GatewayStatus = { state: "disabled" };
  let handle: GatewayRuntimeHandle | null = null;
  let generation = 0;

  return {
    status: () => current,
    enable: async (): Promise<GatewayStatus> => {
      if (current.state === "running" || current.state === "starting") return current;
      const enableGeneration = ++generation;
      current = { state: "starting" };
      try {
        const module = await input.load();
        const started = await module.start(input.port);
        if (generation !== enableGeneration) {
          await started.stop();
          return current;
        }
        handle = started;
        current = { state: "running" };
      } catch (error) {
        if (generation === enableGeneration) {
          handle = null;
          current = {
            state: "degraded",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return current;
    },
    disable: async (): Promise<void> => {
      generation += 1;
      const running = handle;
      handle = null;
      current = { state: "disabled" };
      if (running !== null) await running.stop();
    },
  };
}
