import {
  WS_METHODS,
  type EnvironmentId,
  type VoiceExecutionInput,
  type VoiceExecutionSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";

export type VoiceExecutionPort = (input: VoiceExecutionInput) => Promise<VoiceExecutionSnapshot>;
export function createVoiceExecutionPort(
  context: Context.Context<EnvironmentRegistry>,
  environmentId: EnvironmentId,
): VoiceExecutionPort {
  return (input) =>
    Effect.runPromiseWith(context)(
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        return yield* registry.run(environmentId, request(WS_METHODS.voiceExecute, input));
      }),
    );
}
