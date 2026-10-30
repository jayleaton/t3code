import { createTailnetDeviceAtoms } from "@t3tools/client-runtime/state/tailnetDevices";

import { connectionAtomRuntime } from "../connection/runtime";

export const tailnetDevices = createTailnetDeviceAtoms(connectionAtomRuntime);
