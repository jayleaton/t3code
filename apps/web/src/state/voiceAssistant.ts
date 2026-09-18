import { createVoiceAssistantEnvironmentAtoms } from "@t3tools/client-runtime/state/voice-assistant";

import { connectionAtomRuntime } from "../connection/runtime";

export const voiceAssistantEnvironment =
  createVoiceAssistantEnvironmentAtoms(connectionAtomRuntime);
