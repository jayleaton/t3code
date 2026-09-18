import { AudioLines, LoaderCircle, Mic } from "lucide-react";

import { useVoiceAssistantHost } from "./VoiceAssistantHost";

const BAR_THRESHOLDS = [0.12, 0.22, 0.35, 0.5, 0.68] as const;

function LevelBars({ level }: { readonly level: number }) {
  return (
    <span className="flex h-4 items-end gap-0.5" aria-hidden="true">
      {BAR_THRESHOLDS.map((threshold, index) => (
        <span
          key={index}
          className={
            level >= threshold
              ? "w-1 rounded-sm bg-primary"
              : "w-1 rounded-sm bg-muted-foreground/30"
          }
          style={{ height: `${6 + index * 2}px` }}
        />
      ))}
    </span>
  );
}

/**
 * Always-visible status while voice is armed, so push-to-talk is obvious even
 * with the settings dialog closed, and so "waiting", "thinking", and
 * "speaking" are distinguishable instead of an ambiguous spinner.
 */
export function VoiceAssistantIndicator() {
  const { state, microphoneLevel, microphoneActive } = useVoiceAssistantHost();
  if (state.mode === "off") {
    return null;
  }

  const listening = microphoneActive || state.input === "capturing";
  const connected = state.transport === "ready";

  const status = !connected
    ? ({ label: "Connecting…", icon: "connecting" } as const)
    : listening
      ? ({ label: "Listening…", icon: "listening" } as const)
      : state.output === "preparing"
        ? ({ label: "Thinking…", icon: "thinking" } as const)
        : state.output === "speaking"
          ? ({ label: "Speaking…", icon: "speaking" } as const)
          : null;

  if (status === null) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-3 rounded-full border border-border/60 bg-card/95 px-4 py-2 shadow-lg backdrop-blur-sm"
      >
        {status.icon === "connecting" || status.icon === "thinking" ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : status.icon === "speaking" ? (
          <AudioLines className="size-4 text-primary" aria-hidden="true" />
        ) : (
          <Mic className="size-4 text-primary" aria-hidden="true" />
        )}
        <span className="text-sm text-foreground">{status.label}</span>
        {status.icon === "listening" ? <LevelBars level={microphoneLevel} /> : null}
      </div>
    </div>
  );
}
