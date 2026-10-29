import { decodeAgentPresets } from "@t3tools/shared/agentPresets";

// Loaded with a dynamic import so preset text stays out of the main bundle.
const files = import.meta.glob<string>(
  "../../../../../packages/shared/src/agentPresets/{presets,skills}/**/*",
  { query: "?raw", import: "default", eager: true },
);
const root = "../../../../../packages/shared/src/agentPresets/";

export const agentPresets = decodeAgentPresets(
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path.slice(root.length), text])),
);
