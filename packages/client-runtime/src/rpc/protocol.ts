import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Pings go out every 5 seconds. A server busy for a few seconds stops answering
// them, and a lossy mobile or tailnet path can drop everything for ~5 seconds at
// a time while TCP backs off its retransmits. Allow 30 seconds without any frame
// before dropping the socket; network changes and app resumes still probe sooner.
export const PING_TIMEOUT = "30 seconds";
