// @effect-diagnostics preferSchemaOverJson:off - debug transcript summaries are plain strings.
import { useSyncExternalStore } from "react";

export type VoiceTranscriptRole = "user" | "assistant" | "tool";

export interface VoiceTranscriptEntry {
  readonly id: string;
  readonly role: VoiceTranscriptRole;
  readonly text: string;
}

/**
 * Debug transcript kept outside React state: live transcripts update many times
 * per second, and pushing them through the app-wide voice provider context would
 * re-render the whole tree. Only the transcript popover subscribes.
 */
let entries: ReadonlyArray<VoiceTranscriptEntry> = [];
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const voiceTranscript = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): ReadonlyArray<VoiceTranscriptEntry> {
    return entries;
  },
  upsert(id: string, role: VoiceTranscriptRole, text: string): void {
    const index = entries.findIndex((entry) => entry.id === id);
    entries =
      index >= 0
        ? entries.map((entry, at) => (at === index ? { id, role, text } : entry))
        : [...entries, { id, role, text }];
    emit();
  },
  push(role: VoiceTranscriptRole, text: string): void {
    entries = [...entries, { id: `${role}-${Date.now()}-${entries.length}`, role, text }];
    emit();
  },
  clear(): void {
    entries = [];
    emit();
  },
};

export function useVoiceTranscript(): ReadonlyArray<VoiceTranscriptEntry> {
  return useSyncExternalStore(
    voiceTranscript.subscribe,
    voiceTranscript.getSnapshot,
    voiceTranscript.getSnapshot,
  );
}

/** Short, safe one-line rendering of a tool argument or result for the log. */
export function summarizeVoiceValue(value: unknown, maxLength = 180): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxLength);
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return String(value);
  }
}
