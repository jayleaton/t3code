import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "../ui/combobox";
import { selectTriggerVariants } from "../ui/select";
import { agentModelOptions } from "./agentModelCatalog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { AgentSkill, McpGatewayProfile, ServerProvider } from "@t3tools/contracts";
import { MCP_GATEWAY_RUNTIME_MODE_LABELS } from "@t3tools/contracts";
import { AgentIcon, agentColors, agentIcons } from "./AgentIcon";
import { useRef, useState, type CSSProperties } from "react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { randomUUID } from "../../lib/utils";

const emptySkills: ReadonlyArray<AgentSkill> = [];

export function AgentEditor({
  profile,
  profiles,
  skills = emptySkills,
  providers,
  machines,
  onSave,
  onClose,
}: {
  profile: McpGatewayProfile | null;
  profiles: ReadonlyArray<McpGatewayProfile>;
  skills?: ReadonlyArray<AgentSkill>;
  providers: ReadonlyArray<ServerProvider & { readonly environmentId: string }>;
  machines: ReadonlyArray<{ environmentId: string; label: string }>;
  onSave: (profile: McpGatewayProfile) => Promise<boolean | undefined>;
  onClose: () => void;
}) {
  const skillsTriggerRef = useRef<HTMLButtonElement>(null);
  const [skillIds, setSkillIds] = useState<ReadonlyArray<string>>(profile?.skillIds ?? []);
  const [systemPrompt, setSystemPrompt] = useState(profile?.systemPrompt ?? "");
  const [color, setColor] = useState(
    profile?.color ??
      agentColors[
        Math.max(
          0,
          profile
            ? profiles.findIndex((item) => item.profileId === profile.profileId)
            : profiles.length,
        ) % agentColors.length
      ]!,
  );
  const [icon, setIcon] = useState<NonNullable<McpGatewayProfile["icon"]>>(profile?.icon ?? "orb");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [name, setName] = useState(profile?.name ?? "");
  const [providerLabel, setProviderLabel] = useState(profile?.providerLabel ?? "");
  const [modelLabel, setModelLabel] = useState(profile?.modelLabel ?? "");
  const [thinking, setThinking] = useState(profile?.reasoningEffort ?? "");
  const [runtimeMode, setRuntimeMode] = useState<McpGatewayProfile["runtimeMode"]>(
    profile?.runtimeMode ?? "approval-required",
  );
  const [interactionMode, setInteractionMode] = useState<McpGatewayProfile["interactionMode"]>(
    profile?.interactionMode ?? "default",
  );
  const [environmentIds, setEnvironmentIds] = useState<ReadonlyArray<string>>(
    profile?.environmentIds ?? [],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const availableProviders = providers.filter(
    (provider) => environmentIds.length === 0 || environmentIds.includes(provider.environmentId),
  );
  const providerLabels = [
    ...new Set(
      availableProviders.filter((p) => p.enabled).map((p) => p.displayName?.trim() || p.driver),
    ),
  ];
  const models = agentModelOptions(providers, environmentIds, providerLabel);
  const selectedModel =
    models.find((model) => model.slug === modelLabel) ??
    (models.filter((model) => model.name === modelLabel).length === 1
      ? models.find((model) => model.name === modelLabel)
      : undefined);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="agent-dialog p-6">
        <DialogTitle>{profile ? "Edit agent" : "Create agent"}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Name a specialist. Choose its model and machines. It starts working when you give it a
          task.
        </DialogDescription>
        <form
          className="agent-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              profiles.some((p) => p.profileId !== profile?.profileId && p.name === name.trim())
            ) {
              setError("An agent with this name already exists.");
              return;
            }
            setSaving(true);
            setError("");
            const now = new Date().toISOString();
            try {
              const saved = await onSave({
                profileId: profile?.profileId ?? randomUUID(),
                name: name.trim(),
                description: description.trim(),
                systemPrompt,
                skillIds,
                color,
                icon,
                revision: profile?.revision ?? 1,
                providerLabel,
                modelLabel: selectedModel?.slug ?? modelLabel,
                ...(thinking.trim() ? { reasoningEffort: thinking.trim() } : {}),
                runtimeMode,
                interactionMode,
                ...(environmentIds.length ? { environmentIds } : {}),
                createdAt: profile?.createdAt ?? now,
                updatedAt: now,
              });
              if (saved) onClose();
              else setError("Could not save the agent. Check your connection and try again.");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not save agent.");
            } finally {
              setSaving(false);
            }
          }}
        >
          <label>
            Name
            <input
              autoFocus
              required
              maxLength={200}
              placeholder="Write, Review, Research…"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Specialization
            <input
              maxLength={280}
              placeholder="Reviews code for correctness, security, and maintainability"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              A short description shown on the board and in MCP.
            </span>
          </label>
          <fieldset
            className="agent-appearance"
            style={{ "--agent-color": color } as CSSProperties}
          >
            <legend>Appearance</legend>
            <div className="agent-appearance-preview">
              <AgentIcon icon={icon} />
              <strong>{name || "Your agent"}</strong>
            </div>
            <label>
              Color
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
            <div className="agent-color-options">
              {agentColors.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Use color ${value}`}
                  aria-pressed={color === value}
                  style={{ background: value }}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
            <div className="agent-icon-options" role="group" aria-label="Icon">
              {Object.entries(agentIcons).map(([value, label]) => (
                <Tooltip key={value}>
                  <TooltipTrigger
                    render={<button type="button" />}
                    aria-label={label}
                    aria-pressed={icon === value}
                    onClick={() => setIcon(value as NonNullable<McpGatewayProfile["icon"]>)}
                  >
                    <AgentIcon icon={value as McpGatewayProfile["icon"]} />
                  </TooltipTrigger>
                  <TooltipPopup>{label}</TooltipPopup>
                </Tooltip>
              ))}
            </div>
          </fieldset>
          <label>
            System prompt
            <textarea
              rows={6}
              maxLength={32000}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="Describe this agent’s role, workflow, and expected output…"
            />
            <span className="text-xs text-muted-foreground">
              Prompt and skill changes apply when this agent is next used, including existing chats.
            </span>
          </label>
          <fieldset>
            <legend>Skills</legend>
            {skills.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Add reusable skills from the Agents board.
              </p>
            )}
            {skills.length > 0 && (
              <Combobox
                multiple
                items={skills.map((skill) => skill.skillId)}
                value={[...skillIds]}
                onValueChange={setSkillIds}
                itemToStringLabel={(id) => skills.find((skill) => skill.skillId === id)?.name ?? id}
              >
                <ComboboxTrigger
                  ref={skillsTriggerRef}
                  aria-label="Select skills"
                  className={selectTriggerVariants({ className: "w-full" })}
                >
                  <span className="min-w-0 truncate">
                    {skillIds.length === 0
                      ? "Select skills…"
                      : skillIds.length === 1
                        ? (skills.find((skill) => skill.skillId === skillIds[0])?.name ??
                          "1 skill selected")
                        : `${skillIds.length} skills selected`}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
                </ComboboxTrigger>
                <ComboboxPopup anchor={skillsTriggerRef} className="w-(--anchor-width)">
                  <ComboboxSearchInput placeholder="Search skills…" aria-label="Search skills" />
                  <ComboboxEmpty>No skills found.</ComboboxEmpty>
                  <ComboboxList>
                    {(id: string) => {
                      const skill = skills.find((item) => item.skillId === id);
                      return (
                        <ComboboxItem key={id} value={id}>
                          <div className="flex items-start gap-2">
                            <CheckIcon
                              aria-hidden
                              className={`mt-0.5 size-4 shrink-0 ${skillIds.includes(id) ? "" : "invisible"}`}
                            />
                            <div className="min-w-0">
                              <div className="break-words">{skill?.name ?? id}</div>
                              {skill?.description && (
                                <div className="text-xs text-muted-foreground line-clamp-2">
                                  {skill.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </ComboboxItem>
                      );
                    }}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            )}
          </fieldset>
          <div className="agent-form-grid">
            <label>
              Provider
              <select
                required
                value={providerLabel}
                onChange={(e) => {
                  setProviderLabel(e.target.value);
                  setModelLabel("");
                }}
              >
                <option value="">Select provider</option>
                {[...new Set([...providerLabels, ...(providerLabel ? [providerLabel] : [])])].map(
                  (label) => (
                    <option key={label}>{label}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              Model
              <select
                required
                value={selectedModel?.slug ?? modelLabel}
                onChange={(e) => setModelLabel(e.target.value)}
              >
                <option value="">Select model</option>
                {modelLabel && !selectedModel && (
                  <option value={modelLabel} disabled>
                    {modelLabel} — unavailable; select a model
                  </option>
                )}
                {models.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.name} ({model.slug})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Thinking
              <input
                placeholder="Provider default"
                list="agent-thinking"
                value={thinking}
                onChange={(e) => setThinking(e.target.value)}
              />
              <datalist id="agent-thinking">
                {["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </datalist>
            </label>
            <label>
              Permission mode
              <select
                value={runtimeMode}
                onChange={(e) => setRuntimeMode(e.target.value as McpGatewayProfile["runtimeMode"])}
              >
                {Object.entries(MCP_GATEWAY_RUNTIME_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Interaction
              <select
                value={interactionMode}
                onChange={(e) =>
                  setInteractionMode(e.target.value as McpGatewayProfile["interactionMode"])
                }
              >
                <option value="default">Default</option>
                <option value="plan">Plan</option>
              </select>
            </label>
          </div>
          <fieldset>
            <legend>
              Machines <span className="text-muted-foreground">· none selected means any</span>
            </legend>
            <div className="agent-machines">
              {machines.map((machine) => (
                <label key={machine.environmentId}>
                  <input
                    type="checkbox"
                    checked={environmentIds.includes(machine.environmentId)}
                    onChange={(e) =>
                      setEnvironmentIds(
                        e.target.checked
                          ? [...environmentIds, machine.environmentId]
                          : environmentIds.filter((id) => id !== machine.environmentId),
                      )
                    }
                  />
                  {machine.label}
                </label>
              ))}
            </div>
          </fieldset>
          {profile && (
            <p className="text-xs text-muted-foreground">
              Existing threads receive updated prompts and skills but keep their original model and
              permissions.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="agent-primary"
              disabled={saving || !name.trim() || !providerLabel || !selectedModel}
            >
              {saving ? "Saving…" : profile ? "Save agent" : "Create agent"}
            </button>
          </footer>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
