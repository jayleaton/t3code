import type { AgentPreset } from "@t3tools/shared/agentPresets";
import { ArrowLeftIcon, LayersIcon, PencilLineIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { AgentIcon } from "./AgentIcon";

const loadAgentPresets = () => import("./agentPresetBundle");

export const AGENT_PRESET_SETUP_NOTE =
  "Some agents might require specific software setup for full compatibility.";

export function AgentPresetPicker({
  loadedPresets,
  onScratch,
  onPick,
  onClose,
}: {
  /** Presets from an earlier visit; reopens the list when backing out of the editor. */
  loadedPresets: ReadonlyArray<AgentPreset> | null;
  onScratch: () => void;
  onPick: (preset: AgentPreset, presets: ReadonlyArray<AgentPreset>) => void;
  onClose: () => void;
}) {
  const [presets, setPresets] = useState(loadedPresets);
  const [error, setError] = useState("");
  const [step, setStep] = useState<"start" | "presets">(loadedPresets ? "presets" : "start");
  const load = () => {
    setStep("presets");
    setError("");
    if (presets) return;
    loadAgentPresets().then(
      (bundle) => setPresets(bundle.agentPresets),
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load preconfigured agents."),
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <div className="agent-dialog p-6">
          <DialogTitle>{step === "start" ? "New agent" : "Preconfigured agents"}</DialogTitle>
          <DialogDescription className="mt-2">
            {step === "start"
              ? "Start from a blank agent or from a preconfigured one you can edit before saving."
              : AGENT_PRESET_SETUP_NOTE}
          </DialogDescription>
          {step === "start" ? (
            <div className="agent-start-options">
              <button type="button" onClick={onScratch}>
                <PencilLineIcon size={20} />
                <strong>Start from scratch</strong>
                <span>Name a specialist and write its instructions yourself.</span>
              </button>
              <button type="button" onClick={load}>
                <LayersIcon size={20} />
                <strong>Preconfigured</strong>
                <span>Start from a ready-made agent with its prompt, model and skills.</span>
              </button>
            </div>
          ) : (
            <div className="agent-preset-list" aria-busy={presets === null && !error}>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {!error && presets === null && (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
              {presets?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  This version of T3 Code has no preconfigured agents.
                </p>
              )}
              {presets?.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="agent-preset-card"
                  style={{ "--agent-color": preset.color } as CSSProperties}
                  onClick={() => onPick(preset, presets)}
                >
                  <AgentIcon icon={preset.icon} />
                  <span className="agent-preset-body">
                    <strong>{preset.name}</strong>
                    <span>{preset.description}</span>
                    <span className="agent-preset-meta">
                      {preset.model.model}
                      {preset.skills.length > 0 &&
                        ` · ${preset.skills.map((skill) => skill.name).join(", ")}`}
                    </span>
                    {preset.setupNotes.length > 0 && (
                      <ul className="agent-preset-notes">
                        {preset.setupNotes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="agent-form">
            <footer>
              {step === "presets" && (
                <button type="button" className="mr-auto" onClick={() => setStep("start")}>
                  <ArrowLeftIcon size={14} className="inline" /> Back
                </button>
              )}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </footer>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
