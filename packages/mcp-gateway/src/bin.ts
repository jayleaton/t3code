#!/usr/bin/env node
import * as NodeOS from "node:os";

import { connectSharedGateway, launchSharedOwner, proxyMcpStdio } from "./sharedLauncher.ts";
import {
  gatewayBuild,
  sharedGatewayConfigFromEnvironment,
  startSharedGatewayOwner,
} from "./sharedOwner.ts";

const config = sharedGatewayConfigFromEnvironment(process.env, NodeOS.homedir());

try {
  const entryPoint = process.argv[1]!;
  const build = gatewayBuild(entryPoint);
  if (process.argv.includes("--shared-owner")) {
    const owner = await startSharedGatewayOwner(config, {
      build,
      onIdle: () => {
        void owner?.close();
      },
    });
    // The launcher waits for this receipt, rather than guessing when the port is ready.
    if (process.send !== undefined) {
      await new Promise<void>((resolve, reject) =>
        process.send?.({ type: "ready" }, (error: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
    if (owner !== undefined) {
      const stop = () => {
        void owner.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } else {
    const connect = () =>
      connectSharedGateway(
        config,
        async () => {
          await launchSharedOwner(entryPoint, config);
        },
        build.id,
      );
    await proxyMcpStdio(await connect(), connect);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send !== undefined && process.connected) {
    process.send({ type: "error", message });
    process.disconnect();
  }
  process.stderr.write(`t3-mcp-gateway: ${message}\n`);
  process.exitCode = 1;
}
