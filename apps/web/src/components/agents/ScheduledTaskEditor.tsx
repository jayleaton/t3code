import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  type McpGatewayProfile,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";

import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import {
  scheduledTaskEnvironment,
  type EnvironmentScheduledTask,
} from "../../state/scheduledTasks";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { agentMachineUnavailableReason } from "./agentMachineAvailability";
import {
  cronToRepeatForm,
  isoToLocalInput,
  localInputToIso,
  localTimeZone,
  repeatFormToCron,
  WEEKDAY_NAMES,
  type RepeatForm,
  type RepeatPreset,
} from "./scheduledTasks.logic";

const REPEAT_PRESETS: ReadonlyArray<readonly [RepeatPreset, string]> = [
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["weekly", "Every week"],
  ["hourly", "Every hour"],
  ["custom", "Custom (cron)"],
];

/** Compares at the editor's minute precision, so an untouched runAt with seconds is not a change. */
function scheduleChanged(before: ScheduledTaskSchedule, after: ScheduledTaskSchedule): boolean {
  if (before.kind === "once" && after.kind === "once") {
    return isoToLocalInput(before.runAt) !== isoToLocalInput(after.runAt);
  }
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** The top of the next hour, as a sensible default for a one-time run. */
function nextHourLocalInput(): string {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return isoToLocalInput(date.toISOString());
}

export function ScheduledTaskEditor({
  task,
  profiles,
  initialProfileId,
  onClose,
}: {
  /** The task to edit, or null to create one. */
  task: EnvironmentScheduledTask | null;
  profiles: ReadonlyArray<McpGatewayProfile>;
  initialProfileId?: string | undefined;
  onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const existing = task?.task;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [profileId, setProfileId] = useState(
    existing?.profileId ?? initialProfileId ?? profiles[0]?.profileId ?? "",
  );
  const [chosenMachine, setMachine] = useState<string>(task?.environmentId ?? "");
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? "");
  const [kind, setKind] = useState<ScheduledTaskSchedule["kind"]>(
    existing?.schedule.kind ?? "cron",
  );
  const [runAt, setRunAt] = useState(
    existing?.schedule.kind === "once"
      ? isoToLocalInput(existing.schedule.runAt)
      : nextHourLocalInput(),
  );
  const [repeat, setRepeat] = useState<RepeatForm>(
    existing?.schedule.kind === "cron"
      ? cronToRepeatForm(existing.schedule.expression)
      : { preset: "daily", time: "07:00", weekday: 1, expression: "0 7 * * *" },
  );
  const [timezone, setTimezone] = useState(
    existing?.schedule.kind === "cron" ? existing.schedule.timezone : localTimeZone(),
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const create = useAtomCommand(scheduledTaskEnvironment.create, { reportFailure: false });
  const update = useAtomCommand(scheduledTaskEnvironment.update, { reportFailure: false });

  const profile = profiles.find((item) => item.profileId === profileId);
  const machines = environments
    .filter((env) => env.serverConfig?.environment.capabilities.scheduledTasks === true)
    .map((env) => ({
      env,
      reason: profile ? agentMachineUnavailableReason(profile, env) : undefined,
    }));
  const eligible = machines.filter(({ reason }) => reason === undefined);
  // With a single machine that can run the agent there is nothing to choose.
  const machine = chosenMachine || (eligible.length === 1 ? eligible[0]!.env.environmentId : "");
  const target = machines.find(
    ({ env, reason }) => env.environmentId === machine && reason === undefined,
  )?.env;
  const targetProjects = projects
    .filter((project) => project.environmentId === machine)
    .toSorted((a, b) => a.title.localeCompare(b.title));

  const buildSchedule = (): ScheduledTaskSchedule | string => {
    if (kind === "once") {
      const iso = localInputToIso(runAt);
      return iso === null ? "Pick a date and time." : { kind: "once", runAt: iso };
    }
    const expression = repeatFormToCron(repeat);
    if (expression === "") return "Enter a cron expression.";
    return { kind: "cron", expression, timezone: timezone.trim() || localTimeZone() };
  };

  const save = async () => {
    const schedule = buildSchedule();
    if (typeof schedule === "string") return setError(schedule);
    if (!target || !profile || projectId === "" || prompt.trim() === "") {
      return setError("Choose an agent, machine, and project, and write a prompt.");
    }
    setSaving(true);
    setError("");
    const environmentId = EnvironmentId.make(target.environmentId);
    const trimmedTitle = title.trim();
    const result = existing
      ? await update({
          environmentId,
          input: {
            taskId: ScheduledTaskId.make(existing.taskId),
            // Only send what changed: resending an unchanged one-time schedule would try to re-arm it.
            patch: {
              ...(trimmedTitle !== "" && trimmedTitle !== existing.title
                ? { title: trimmedTitle }
                : {}),
              ...(prompt.trim() !== existing.prompt ? { prompt: prompt.trim() } : {}),
              ...(profileId !== existing.profileId ? { profileId } : {}),
              ...(projectId !== existing.projectId ? { projectId: ProjectId.make(projectId) } : {}),
              ...(scheduleChanged(existing.schedule, schedule) ? { schedule } : {}),
              ...(enabled !== existing.enabled ? { enabled } : {}),
            },
          },
        })
      : await create({
          environmentId,
          input: {
            ...(trimmedTitle === "" ? {} : { title: trimmedTitle }),
            prompt: prompt.trim(),
            profileId,
            projectId: ProjectId.make(projectId),
            schedule,
            enabled,
          },
        });
    setSaving(false);
    if (result._tag === "Success") return onClose();
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not save the scheduled task.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription>
            The agent receives this prompt on schedule. Every run posts into the same thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="agent-form">
            <label>
              Prompt
              <textarea
                rows={5}
                value={prompt}
                placeholder="Pull the latest changes from origin and summarise what changed."
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label>
              Title
              <input
                value={title}
                placeholder="Defaults to the first line of the prompt"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="agent-form-grid">
              <label>
                Agent
                <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                  {profiles.map((item) => (
                    <option
                      key={item.profileId}
                      value={item.profileId}
                      disabled={item.runtimeMode === "read-only"}
                    >
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Machine
                <select
                  value={machine}
                  disabled={existing !== undefined}
                  onChange={(event) => {
                    setMachine(event.target.value);
                    setProjectId("");
                  }}
                >
                  <option value="" disabled>
                    Select machine
                  </option>
                  {machines.map(({ env, reason }) => (
                    <option
                      key={env.environmentId}
                      value={env.environmentId}
                      disabled={reason !== undefined}
                    >
                      {env.label}
                      {reason ? ` — ${reason}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Project
              <select
                value={projectId}
                disabled={!target}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="" disabled>
                  Select project
                </option>
                {targetProjects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {existing?.threadId &&
              (profileId !== existing.profileId || projectId !== existing.projectId) && (
                <p className="text-xs text-muted-foreground">
                  The next run starts a new thread for the new agent or project.
                </p>
              )}
            <div className="agent-form-grid">
              <label>
                Runs
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ScheduledTaskSchedule["kind"])}
                >
                  <option value="cron">On a schedule</option>
                  <option value="once">Once</option>
                </select>
              </label>
              {kind === "once" ? (
                <label>
                  At
                  <input
                    type="datetime-local"
                    value={runAt}
                    onChange={(event) => setRunAt(event.target.value)}
                  />
                </label>
              ) : (
                <label>
                  Repeat
                  <select
                    value={repeat.preset}
                    onChange={(event) => {
                      const preset = event.target.value as RepeatPreset;
                      setRepeat((current) => ({
                        ...current,
                        preset,
                        expression:
                          preset === "custom" ? repeatFormToCron(current) : current.expression,
                      }));
                    }}
                  >
                    {REPEAT_PRESETS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {kind === "cron" && (
              <div className="agent-form-grid">
                {repeat.preset === "custom" ? (
                  <label>
                    Cron (minute hour day month weekday)
                    <input
                      value={repeat.expression}
                      placeholder="0 7 * * 1-5"
                      onChange={(event) =>
                        setRepeat((current) => ({ ...current, expression: event.target.value }))
                      }
                    />
                  </label>
                ) : repeat.preset === "hourly" ? (
                  <label>
                    Minute past the hour
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={Number(repeat.time.slice(3))}
                      onChange={(event) =>
                        setRepeat((current) => ({
                          ...current,
                          time: `00:${String(event.target.valueAsNumber || 0).padStart(2, "0")}`,
                        }))
                      }
                    />
                  </label>
                ) : (
                  <label>
                    Time
                    <input
                      type="time"
                      value={repeat.time}
                      onChange={(event) =>
                        setRepeat((current) => ({ ...current, time: event.target.value }))
                      }
                    />
                  </label>
                )}
                {repeat.preset === "weekly" && (
                  <label>
                    Day
                    <select
                      value={repeat.weekday}
                      onChange={(event) =>
                        setRepeat((current) => ({
                          ...current,
                          weekday: Number(event.target.value),
                        }))
                      }
                    >
                      {WEEKDAY_NAMES.map((name, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Time zone
                  <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                </label>
              </div>
            )}
            <label className="agent-checkbox-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
            <p className="text-xs text-muted-foreground">
              Runs while the machine's T3 server is up; a run missed while it was off happens once
              when it is back. The agent's permission mode applies, so an agent that asks for
              approvals will wait for you.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={save}>
            {saving ? "Saving…" : existing ? "Save" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
