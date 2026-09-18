import { AudioLines, Mic } from "lucide-react";

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
 * Always-visible status while the assistant is capturing or speaking, so
 * push-to-talk is obvious even with the settings dialog closed. Rendered by the
 * host provider, which owns the runtime state.
 */
export function VoiceAssistantIndicator() {
  const { state, microphoneLevel, microphoneActive } = useVoiceAssistantHost();
  const listening = microphoneActive || state.input === "capturing";
  const speaking = state.output === "speaking";
  if (!listening && !speaking) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border/60 bg-card/95 px-4 py-2 shadow-lg backdrop-blur-sm">
        {listening ? (
          <Mic className="size-4 text-primary" aria-hidden="true" />
        ) : (
          <AudioLines className="size-4 text-primary" aria-hidden="true" />
        )}
        <span className="text-sm text-foreground">{listening ? "Listening…" : "Speaking…"}</span>
        {listening ? <LevelBars level={microphoneLevel} /> : null}
      </div>
    </div>
  );
}
