import { useState } from "react";
import type { AgentSkill } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { randomUUID } from "../../lib/utils";

export function AgentSkillsEditor({
  skills,
  onSave,
  onClose,
}: {
  skills: ReadonlyArray<AgentSkill>;
  onSave: (skills: ReadonlyArray<AgentSkill>) => Promise<boolean | undefined>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<AgentSkill | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const select = (skill: AgentSkill | null) => {
    setSelected(skill);
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setContent(skill?.content ?? "");
    setError("");
  };
  const save = async (next: ReadonlyArray<AgentSkill>) => {
    setSaving(true);
    setError("");
    try {
      if (await onSave(next)) select(null);
      else setError("Could not save skills. Check your connection and try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skills.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="agent-dialog p-6">
        <DialogTitle>Shared skills</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Edit a skill once, then assign it to agents. Changes sync across connected machines and
          apply on the next use.
        </DialogDescription>
        <form
          className="agent-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const now = new Date().toISOString();
            const skill: AgentSkill = {
              skillId: selected?.skillId ?? randomUUID(),
              name: name.trim(),
              description: description.trim(),
              content,
              revision: selected?.revision ?? 1,
              createdAt: selected?.createdAt ?? now,
              updatedAt: now,
            };
            await save(
              selected
                ? skills.map((item) => (item.skillId === selected.skillId ? skill : item))
                : [...skills, skill],
            );
          }}
        >
          <label>
            Skill
            <select
              disabled={saving}
              value={selected?.skillId ?? ""}
              onChange={(event) =>
                select(skills.find((skill) => skill.skillId === event.target.value) ?? null)
              }
            >
              <option value="">New skill</option>
              {skills.map((skill) => (
                <option key={skill.skillId} value={skill.skillId}>
                  {skill.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            When to use
            <input
              maxLength={1024}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            SKILL.md
            <textarea
              required
              rows={12}
              maxLength={64000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Paste the skill’s Markdown instructions…"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <footer>
            {selected && (
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void save(skills.filter((skill) => skill.skillId !== selected.skillId))
                }
              >
                Delete skill
              </button>
            )}
            <button type="button" disabled={saving} onClick={onClose}>
              Close
            </button>
            <button className="agent-primary" disabled={saving || !name.trim() || !content.trim()}>
              {saving ? "Saving…" : "Save skill"}
            </button>
          </footer>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
