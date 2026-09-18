import { MessageSquare, Trash2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { useVoiceTranscript, voiceTranscript } from "./voiceTranscriptStore";

const ROLE_LABELS = { user: "You", assistant: "Gemini", tool: "Tool" } as const;
const ROLE_CLASSES = {
  user: "text-foreground",
  assistant: "text-primary",
  tool: "text-muted-foreground",
} as const;

function TranscriptPopup() {
  const entries = useVoiceTranscript();
  return (
    <PopoverPopup side="top" align="end" className="w-80">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Voice transcript</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Clear voice transcript"
          onClick={() => voiceTranscript.clear()}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
      <div className="max-h-80 space-y-2 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing yet. Hold push-to-talk and speak, or wait for the assistant.
          </p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="space-y-0.5">
              <span className={`text-[10px] uppercase tracking-wide ${ROLE_CLASSES[entry.role]}`}>
                {ROLE_LABELS[entry.role]}
              </span>
              <p className="whitespace-pre-wrap break-words text-xs text-foreground/90">
                {entry.text}
              </p>
            </div>
          ))
        )}
      </div>
    </PopoverPopup>
  );
}

/** Debug-only mini chat beside the sidebar voice control. */
export function VoiceDebugChat() {
  return (
    <SidebarMenuItem className="shrink-0">
      <Popover>
        <PopoverTrigger render={<SidebarMenuButton aria-label="Voice transcript" size="icon" />}>
          <MessageSquare aria-hidden="true" />
        </PopoverTrigger>
        <TranscriptPopup />
      </Popover>
    </SidebarMenuItem>
  );
}

/** Plain icon trigger for surfaces without the sidebar menu context. */
export function VoiceDebugChatIconButton({ className }: { readonly className?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            aria-label="Voice transcript"
            size="icon-xs"
            variant="outline"
            className={className}
          />
        }
      >
        <MessageSquare aria-hidden="true" />
      </PopoverTrigger>
      <TranscriptPopup />
    </Popover>
  );
}
